import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  COMMS_BILLING_METER_LABELS,
  isCommsPaygBillingEnabled,
  type CommsBillingMeter,
} from "@/lib/comms-billing/rates";

/**
 * Turning recorded usage into money.
 *
 * Usage events are written as communication happens; this is the only place
 * they become Stripe charges. Two rules hold the whole thing together:
 *
 *  1. A usage event is billed AT MOST ONCE. `billed_at` is set in the same
 *     write that records the Stripe invoice item id, and a partial unique index
 *     on that id means a racing retry cannot bill the same event twice even if
 *     this code is wrong.
 *  2. Nothing is charged without a card on file. A manager who never added one
 *     accrues usage and is asked for a card — they are never surprised by a
 *     failed charge on a line they did not know was metered.
 */

const MAX_EVENTS_PER_RUN = 500;

export type CommsInvoiceResult =
  | { ok: true; invoiced: false; reason: "payg_disabled" | "no_usage" | "no_customer" | "no_payment_method" }
  | { ok: true; invoiced: true; invoiceId: string; itemCount: number; totalCents: number }
  | { ok: false; error: string };

type UsageRow = {
  id: string;
  meter: string;
  quantity: number;
  total_cents: number;
};

/**
 * Bill one manager's outstanding usage.
 *
 * Invoice items are created first and the invoice is finalized last, so a
 * failure part-way leaves the items attached to the customer's next invoice
 * rather than dropping the charges. Each item carries the usage event id as its
 * idempotency key, which is what makes a retry safe.
 */
export async function invoiceManagerCommsUsage(
  db: SupabaseClient,
  managerUserId: string,
): Promise<CommsInvoiceResult> {
  if (!isCommsPaygBillingEnabled()) return { ok: true, invoiced: false, reason: "payg_disabled" };

  const { data: rows, error } = await db
    .from("manager_comms_usage_events")
    .select("id, meter, quantity, total_cents")
    .eq("manager_user_id", managerUserId)
    .is("billed_at", null)
    .order("created_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);
  if (error) return { ok: false, error: error.message };

  const events = (rows ?? []) as UsageRow[];
  const billable = events.filter((row) => Number(row.total_cents) > 0);
  if (billable.length === 0) return { ok: true, invoiced: false, reason: "no_usage" };

  const sku = await getManagerPurchaseSku(managerUserId);
  const customerId = sku?.stripeCustomerId?.trim() || null;
  if (!customerId) return { ok: true, invoiced: false, reason: "no_customer" };

  const { data: account } = await db
    .from("manager_comms_billing_accounts")
    .select("has_default_payment_method")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  // No card on file is not an error — it is the expected state for a manager
  // who has not set billing up. Usage keeps accruing and is billed once they do.
  if (!account?.has_default_payment_method) {
    return { ok: true, invoiced: false, reason: "no_payment_method" };
  }

  const stripe = getStripe();
  const nowIso = new Date().toISOString();
  let totalCents = 0;

  for (const row of billable) {
    const meter = row.meter as CommsBillingMeter;
    const amount = Math.round(Number(row.total_cents));
    try {
      const item = await stripe.invoiceItems.create(
        {
          customer: customerId,
          amount,
          currency: "usd",
          description: `${COMMS_BILLING_METER_LABELS[meter] ?? meter} × ${row.quantity}`,
          metadata: { proplane_usage_event_id: row.id, meter: String(row.meter) },
        },
        // The usage event id, so a retried run reuses the same invoice item
        // instead of charging twice.
        { idempotencyKey: `proplane_comms_usage_${row.id}` },
      );
      const { error: markError } = await db
        .from("manager_comms_usage_events")
        .update({ stripe_invoice_item_id: item.id, billed_at: nowIso })
        .eq("id", row.id)
        .is("billed_at", null);
      if (markError) {
        // The charge exists but we could not record it. Stop rather than
        // continue — carrying on would risk re-billing this event next run.
        return { ok: false, error: `usage ${row.id} billed but not marked: ${markError.message}` };
      }
      totalCents += amount;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "invoice item failed" };
    }
  }

  try {
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: "charge_automatically",
      auto_advance: true,
      description: "PropLane communication usage",
      metadata: { proplane_comms_usage: "1" },
    });
    const invoiceId = invoice.id ?? "";
    if (invoiceId) {
      await stripe.invoices.finalizeInvoice(invoiceId);
      await db
        .from("manager_comms_billing_accounts")
        .update({ last_invoiced_at: nowIso, last_invoice_id: invoiceId, updated_at: nowIso })
        .eq("manager_user_id", managerUserId);
    }
    return { ok: true, invoiced: true, invoiceId, itemCount: billable.length, totalCents };
  } catch (e) {
    // The items are already attached to the customer, so they ride on the next
    // invoice. Nothing is lost and nothing is double-charged.
    return { ok: false, error: e instanceof Error ? e.message : "invoice creation failed" };
  }
}
