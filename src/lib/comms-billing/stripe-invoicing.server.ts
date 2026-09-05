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
  // A failed read is NOT "this manager has no Stripe customer". Collapsing the
  // two would silently skip a paying manager and report the run as clean — the
  // same unreadable-as-default trap AGENTS.md calls out for plan reads.
  if (sku?.readFailed) return { ok: false, error: "manager purchase read failed" };
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

  // The invoice is created FIRST, as a draft, and every item is attached to it
  // by id. Creating items loose on the customer and then calling invoices.create
  // sweeps up EVERY pending item that customer has — including subscription
  // prorations from a mid-month tier change — and charges them here, on an
  // invoice that claims to be communication usage.
  let draftInvoiceId = "";
  try {
    const draft = await stripe.invoices.create({
      customer: customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      description: "PropLane communication usage",
      pending_invoice_items_behavior: "exclude",
      metadata: { proplane_comms_usage: "1" },
    });
    draftInvoiceId = draft.id ?? "";
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invoice creation failed" };
  }
  if (!draftInvoiceId) return { ok: false, error: "stripe returned an invoice with no id" };

  for (const row of billable) {
    const meter = row.meter as CommsBillingMeter;
    const amount = Math.round(Number(row.total_cents));

    // CLAIM the event before charging it. Stripe idempotency keys expire after
    // 24 hours, so "create the item, then mark it" loses the race permanently:
    // if the mark failed, the next month's run would create a SECOND item under
    // an expired key and the manager pays twice. Claiming first makes the only
    // failure mode an under-charge, which is the right way round.
    const { data: claimed, error: claimError } = await db
      .from("manager_comms_usage_events")
      .update({ billed_at: nowIso })
      .eq("id", row.id)
      .is("billed_at", null)
      .select("id");
    if (claimError) return { ok: false, error: `claim ${row.id}: ${claimError.message}` };
    // Another run already claimed it — not an error, just not ours to bill.
    if (!claimed || claimed.length === 0) continue;

    try {
      const item = await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: draftInvoiceId,
          amount,
          currency: "usd",
          description: `${COMMS_BILLING_METER_LABELS[meter] ?? meter} × ${row.quantity}`,
          metadata: { proplane_usage_event_id: row.id, meter: String(row.meter) },
        },
        { idempotencyKey: `proplane_comms_usage_${row.id}` },
      );
      await db
        .from("manager_comms_usage_events")
        .update({ stripe_invoice_item_id: item.id })
        .eq("id", row.id);
      totalCents += amount;
    } catch (e) {
      // Release the claim so a later run can retry this event rather than
      // leaving it marked billed against nothing.
      await db
        .from("manager_comms_usage_events")
        .update({ billed_at: null })
        .eq("id", row.id)
        .is("stripe_invoice_item_id", null);
      return { ok: false, error: e instanceof Error ? e.message : "invoice item failed" };
    }
  }

  if (totalCents === 0) {
    // Everything was already claimed by a concurrent run. Leave the empty draft
    // rather than finalizing a $0 invoice at the customer.
    return { ok: true, invoiced: false, reason: "no_usage" };
  }

  try {
    await stripe.invoices.finalizeInvoice(draftInvoiceId, { auto_advance: true });
    await db
      .from("manager_comms_billing_accounts")
      .update({ last_invoiced_at: nowIso, last_invoice_id: draftInvoiceId, updated_at: nowIso })
      .eq("manager_user_id", managerUserId);
    return { ok: true, invoiced: true, invoiceId: draftInvoiceId, itemCount: billable.length, totalCents };
  } catch (e) {
    // The items are attached to this draft, so the charges are not lost — the
    // draft can be finalized by hand or by the next run. Reported as a failure
    // so it is not silently counted as invoiced.
    return { ok: false, error: e instanceof Error ? e.message : "invoice finalize failed" };
  }
}
