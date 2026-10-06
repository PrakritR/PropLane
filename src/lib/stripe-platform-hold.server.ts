import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { track } from "@/lib/analytics/posthog";
import { getStripe } from "@/lib/stripe";
import {
  canCreditPlatformHold,
  directInvoiceHoldSourceId,
  holdsReadyToTransfer,
  type PlatformHoldOwnerRole,
  type PlatformHoldRow,
  type PlatformHoldSource,
} from "@/lib/stripe-platform-hold";

type HoldDbRow = {
  id: string;
  owner_user_id: string;
  owner_role: PlatformHoldOwnerRole;
  source: PlatformHoldSource;
  source_id: string;
  amount_cents: number;
  original_amount_cents?: number | null;
  status: PlatformHoldRow["status"];
  stripe_charge_id: string | null;
  stripe_transfer_id: string | null;
  created_at?: string;
};

function fromDb(row: HoldDbRow): PlatformHoldRow {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerRole: row.owner_role,
    source: row.source,
    sourceId: row.source_id,
    amountCents: row.amount_cents,
    originalAmountCents: row.original_amount_cents,
    status: row.status,
    stripeChargeId: row.stripe_charge_id,
    stripeTransferId: row.stripe_transfer_id,
    createdAt: row.created_at,
  };
}

export async function findPlatformHold(
  db: SupabaseClient,
  source: PlatformHoldSource,
  sourceId: string,
): Promise<PlatformHoldRow | null> {
  const { data, error } = await db
    .from("platform_payment_holds")
    .select(
      "id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id",
    )
    .eq("source", source)
    .eq("source_id", sourceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromDb(data as HoldDbRow) : null;
}

/** One captured PI may be delivered under Checkout and PI event aliases. */
export async function findPlatformHoldByPaymentIntent(
  db: SupabaseClient,
  paymentIntentId: string,
): Promise<PlatformHoldRow | null> {
  const { data, error } = await db.from("platform_payment_holds")
    .select("id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id")
    .eq("source_payment_intent_id", paymentIntentId).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromDb(data as HoldDbRow) : null;
}

export async function listPlatformHoldsForOwner(
  db: SupabaseClient,
  ownerUserId: string,
): Promise<PlatformHoldRow[]> {
  const rows: PlatformHoldRow[] = [];
  const pageSize = 500;
  for (let offset = 0; ;) {
    const { data, error } = await db
      .from("platform_payment_holds")
      .select(
        "id, owner_user_id, owner_role, source, source_id, amount_cents, original_amount_cents, status, stripe_charge_id, stripe_transfer_id, created_at",
      )
      .eq("owner_user_id", ownerUserId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []).map((row) => fromDb(row as HoldDbRow));
    rows.push(...page);
    if (page.length === 0) return rows;
    offset += page.length;
  }
}

export async function readOwnerPlatformFunds(
  db: SupabaseClient, ownerUserId: string,
): Promise<{ heldCents: number; releasePendingCents: number }> {
  const { data, error } = await db.rpc("read_platform_hold_owner_funds", { p_owner: ownerUserId });
  if (error) throw new Error(`Could not read held payment funds: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const parseTotal = (value: unknown): number => {
    if (typeof value !== "number" &&
        (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))) {
      throw new Error("Held payment funds have an invalid total.");
    }
    return Number(value);
  };
  const heldCents = parseTotal(row?.held_cents);
  const releasePendingCents = parseTotal(row?.release_pending_cents);
  if (!Number.isSafeInteger(heldCents) || heldCents < 0 ||
      !Number.isSafeInteger(releasePendingCents) || releasePendingCents < 0) {
    throw new Error("Held payment funds have an invalid total.");
  }
  return { heldCents, releasePendingCents };
}

export async function sumHeldCentsForOwner(db: SupabaseClient, ownerUserId: string): Promise<number> {
  return (await readOwnerPlatformFunds(db, ownerUserId)).heldCents;
}

export async function creditPlatformHold(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    ownerRole: PlatformHoldOwnerRole;
    source: PlatformHoldSource;
    sourceId: string;
    amountCents: number;
    stripeChargeId?: string | null;
  },
): Promise<{ credited: boolean; hold: PlatformHoldRow | null }> {
  const amountCents = Math.round(input.amountCents);
  if (!input.ownerUserId.trim() || amountCents <= 0) return { credited: false, hold: null };

  const existing = await findPlatformHold(db, input.source, input.sourceId);
  if (!canCreditPlatformHold(existing)) {
    if (existing && (existing.ownerUserId !== input.ownerUserId || existing.ownerRole !== input.ownerRole || existing.amountCents !== amountCents)) {
      throw new Error("Existing platform hold does not match paid charge.");
    }
    if (existing && input.stripeChargeId && existing.stripeChargeId && existing.stripeChargeId !== input.stripeChargeId) {
      throw new Error("Existing platform hold points to another Stripe charge.");
    }
    if (existing && input.stripeChargeId && !existing.stripeChargeId) {
      const { error } = await db.from("platform_payment_holds")
        .update({ stripe_charge_id: input.stripeChargeId, updated_at: new Date().toISOString() })
        .eq("id", existing.id).is("stripe_charge_id", null);
      if (error) throw new Error(error.message);
      // The conditional write may affect zero rows when another event hydrated
      // the same hold first. Never report a charge ID that was not persisted.
      const durable = await findPlatformHold(db, input.source, input.sourceId);
      if (!durable || durable.id !== existing.id || durable.ownerUserId !== input.ownerUserId ||
          durable.ownerRole !== input.ownerRole || durable.amountCents !== amountCents ||
          durable.stripeChargeId !== input.stripeChargeId) {
        throw new Error("Platform hold charge hydration lost source arbitration.");
      }
      return { credited: false, hold: durable };
    }
    return { credited: false, hold: existing };
  }

  const { data, error } = await db
    .from("platform_payment_holds")
    .insert({
      owner_user_id: input.ownerUserId,
      owner_role: input.ownerRole,
      source: input.source,
      source_id: input.sourceId,
      amount_cents: amountCents,
      status: "held",
      stripe_charge_id: input.stripeChargeId ?? null,
    })
    .select(
      "id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id",
    )
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const raced = await findPlatformHold(db, input.source, input.sourceId);
      if (!raced || raced.ownerUserId !== input.ownerUserId || raced.ownerRole !== input.ownerRole ||
          raced.amountCents !== amountCents ||
          (input.stripeChargeId && raced.stripeChargeId && raced.stripeChargeId !== input.stripeChargeId)) {
        throw new Error("Concurrent platform hold does not match paid source.");
      }
      // A concurrent writer can have persisted the same immutable source
      // without its charge id. Re-enter the existing-row path to hydrate it.
      if (input.stripeChargeId && !raced.stripeChargeId) {
        return creditPlatformHold(db, input);
      }
      return { credited: false, hold: raced };
    }
    throw new Error(error.message);
  }
  const hold = data ? fromDb(data as HoldDbRow) : null;
  if (!hold) throw new Error("Platform hold insert returned no durable row.");
  track("platform_hold_credited", input.ownerUserId, {
    source: input.source,
    amount_cents: amountCents,
  });
  return { credited: Boolean(hold), hold };
}

export async function refundPlatformHold(
  db: SupabaseClient,
  source: PlatformHoldSource,
  sourceId: string,
): Promise<void> {
  const { error } = await db
    .from("platform_payment_holds")
    .update({ status: "refunded", updated_at: new Date().toISOString() })
    .eq("source", source)
    .eq("source_id", sourceId)
    .eq("status", "held");
  if (error) throw new Error(error.message);
}

export async function refundPlatformHoldByChargeId(db: SupabaseClient, stripeChargeId: string): Promise<void> {
  const id = stripeChargeId.trim();
  if (!id) return;
  const { error } = await db
    .from("platform_payment_holds")
    .update({ status: "refunded", updated_at: new Date().toISOString() })
    .eq("stripe_charge_id", id)
    .eq("status", "held");
  if (error) throw new Error(error.message);
}

export async function transferHoldsForOwner(
  db: SupabaseClient,
  opts: { ownerUserId: string; destinationAccountId: string; stripe?: Stripe },
): Promise<{ transferred: number; failed: number }> {
  const { data, error } = await db
    .from("platform_payment_holds")
    .select(
      "id, owner_user_id, owner_role, source, source_id, amount_cents, status, stripe_charge_id, stripe_transfer_id",
    )
    .eq("owner_user_id", opts.ownerUserId)
    .eq("status", "held");
  if (error) throw new Error(error.message);
  const ready = holdsReadyToTransfer((data ?? []).map((row) => fromDb(row as HoldDbRow)));
  if (ready.length === 0) return { transferred: 0, failed: 0 };

  const stripe = opts.stripe ?? getStripe();
  let transferred = 0;
  let failed = 0;
  for (const hold of ready) {
    try {
      const transfer = await stripe.transfers.create(
        {
          amount: hold.amountCents,
          currency: "usd",
          destination: opts.destinationAccountId,
          metadata: {
            platform_hold_id: hold.id,
            source: hold.source,
            source_id: hold.sourceId,
          },
        },
        { idempotencyKey: `platform-hold:${hold.id}` },
      );
      const { error: updateError } = await db
        .from("platform_payment_holds")
        .update({
          status: "transferred",
          stripe_transfer_id: transfer.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", hold.id)
        .eq("status", "held");
      if (updateError) throw new Error(updateError.message);
      transferred += 1;
      track("platform_hold_transferred", opts.ownerUserId, {
        source: hold.source,
        amount_cents: hold.amountCents,
      });
    } catch (e) {
      failed += 1;
      console.error(
        `[platform-hold] transfer failed for ${hold.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { transferred, failed };
}

export function holdSourceFromCheckoutPurpose(purpose: string | undefined): PlatformHoldSource | null {
  if (purpose === "household_charge") return "household_charge";
  if (purpose === "rental_application_fee") return "application_fee";
  // A linked form's own fee is booked like the application fee it derives from (manager income, held when no Connect).
  if (purpose === "linked_form_fee") return "application_fee";
  if (purpose === "vendor_invoice_pay" || purpose === "vendor_invoice_direct_pay") return "vendor_invoice";
  return null;
}

export async function creditHoldFromPaidSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  stripeChargeId?: string | null,
): Promise<{ credited: boolean }> {
  if (session.metadata?.platform_hold !== "1") return { credited: false };
  // Checkout also emits `completed` while a bank debit is still unpaid.
  // No recipient allocation may exist until the provider confirms capture.
  if (session.status !== "complete" || session.payment_status !== "paid") {
    return { credited: false };
  }
  const source = holdSourceFromCheckoutPurpose(session.metadata.purpose);
  if (!source) return { credited: false };
  const ownerUserId =
    (source === "vendor_invoice"
      ? session.metadata.vendor_user_id
      : session.metadata.manager_user_id)?.trim() ?? "";
  const ownerRole: PlatformHoldOwnerRole = source === "vendor_invoice" ? "vendor" : "manager";
  const amountCents = Number(session.metadata.hold_amount_cents ?? session.metadata.manager_payout_cents ?? 0);
  const sourceId =
    source === "vendor_invoice"
      ? (session.metadata.purpose === "vendor_invoice_direct_pay"
          ? directInvoiceHoldSourceId(session.metadata.invoice_id?.trim() || session.id)
          : (session.metadata.work_order_id?.trim() || session.id))
      : session.id;
  const result = await creditPlatformHold(db, {
    ownerUserId,
    ownerRole,
    source,
    sourceId,
    amountCents,
    stripeChargeId,
  });
  return { credited: result.credited };
}

export async function creditHoldFromPaymentIntent(
  db: SupabaseClient,
  paymentIntent: Stripe.PaymentIntent,
): Promise<{ credited: boolean }> {
  const metadata = paymentIntent.metadata ?? {};
  if (metadata.platform_hold !== "1") return { credited: false };
  if (paymentIntent.status !== "succeeded") return { credited: false };
  const source = holdSourceFromCheckoutPurpose(metadata.purpose);
  // This legacy PI entry point is used only for resident autopay. Vendor PI
  // funding must bind an authenticated payout claim and vendor recipient.
  if (source !== "household_charge") throw new Error("PaymentIntent has no verified resident hold source.");
  const ownerUserId = metadata.manager_user_id?.trim() ?? "";
  const amountCents = Number(metadata.hold_amount_cents ?? metadata.manager_payout_cents ?? 0);
  const chargeId =
    typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id ?? null;
  if (!chargeId?.startsWith("ch_")) {
    throw new Error("Succeeded payment has no actual Stripe charge for its hold.");
  }
  const result = await creditPlatformHold(db, {
    ownerUserId,
    ownerRole: "manager",
    source,
    sourceId: paymentIntent.id,
    amountCents,
    stripeChargeId: chargeId,
  });
  return { credited: result.credited };
}
