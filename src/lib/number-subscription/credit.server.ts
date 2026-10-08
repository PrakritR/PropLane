import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isValidCommsCreditAmountCents } from "@/lib/comms-billing/credit-packs";
import { unitPriceCentsForMeter, type CommsBillingMeter } from "@/lib/comms-billing/rates";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";
import {
  NUMBER_CREDIT_PURPOSE,
  NUMBER_INCLUDED_CREDIT_CENTS,
  safeNumberReturnPath,
  type NumberOwnerRole,
} from "./constants";
import { NumberBillingError, numberServiceEntitled } from "./subscription.server";
import { ensureNumberOwnerStripeCustomerId } from "./stripe.server";

/** A payment that does not match its purchase can never validate: record it, never grant credit. */
export class NumberCreditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumberCreditValidationError";
  }
}

export type NumberCreditReservation =
  | { allowed: true; duplicate: boolean; state: "reserved" | "settled" }
  | { allowed: false; reason: "allowance_exhausted" | "subscription_inactive" | string };

export type NumberCreditBalance = {
  /** Included monthly credit still spendable (0 unless the subscription is `active`). */
  includedCents: number;
  /** Bought credit, never expires. */
  purchasedCents: number;
  totalCents: number;
  /** Next UTC month start, when included credit resets to $3.00. */
  resetsAt: string;
  subscriptionStatus: string | null;
};

const MAX_KEY = 300;

/**
 * Reserve credit BEFORE any provider or model work. Included credit is spent first, then purchased.
 * `ownerUserId` is the vendor/resident whose number this is; callers derive it from the authenticated
 * session or the number's owner row, never from message content. Refused (`allowed: false`) when the
 * subscription is not active/past_due or the balance cannot cover the cost. `allowUnfunded` is only for
 * an unavoidable cost (an inbound text already received): it debits what exists and the platform absorbs
 * the rest.
 *
 * Idempotent per `idempotencyKey`: a replay never debits twice, and reusing a key with a different
 * meter/quantity throws.
 */
export async function reserveNumberCredit(
  ownerUserId: string,
  meter: CommsBillingMeter,
  quantity: number,
  idempotencyKey: string,
  opts: { metadata?: Record<string, unknown>; allowUnfunded?: boolean; db?: SupabaseClient } = {},
): Promise<NumberCreditReservation> {
  const key = idempotencyKey.trim();
  if (
    !ownerUserId.trim() ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000 ||
    !key ||
    key.length > MAX_KEY
  ) {
    throw new Error("Invalid communication usage.");
  }
  const db = opts.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db.rpc("reserve_number_credit", {
    p_owner: ownerUserId,
    p_key: key,
    p_meter: meter,
    p_quantity: quantity,
    p_unit_cents: unitPriceCentsForMeter(meter),
    p_included_cents: NUMBER_INCLUDED_CREDIT_CENTS,
    p_metadata: opts.metadata ?? {},
    p_allow_unfunded: opts.allowUnfunded === true,
  });
  if (error || !data) {
    throw new Error("Communication credit could not be reserved.", {
      cause: error ? { code: error.code, message: error.message } : "empty_result",
    });
  }
  if (data.allowed !== true) return { allowed: false, reason: String(data.reason ?? "allowance_exhausted") };
  return { allowed: true, duplicate: data.duplicate === true, state: data.state };
}

/** Keep the debit (default) or hand it back (`release: true`) once the send's outcome is known. */
export async function finishNumberCredit(
  ownerUserId: string,
  idempotencyKey: string,
  opts: { release?: boolean; db?: SupabaseClient } = {},
): Promise<void> {
  const db = opts.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db.rpc("finish_number_credit", {
    p_owner: ownerUserId,
    p_key: idempotencyKey.trim(),
    p_release: opts.release === true,
  });
  if (error || data !== true) throw new Error("Communication credit reconciliation failed.");
}

/** Settle a variable-quantity reservation against the real quantity, refunding the unused part. */
export async function settleNumberCreditQuantity(
  ownerUserId: string,
  idempotencyKey: string,
  quantity: number,
  opts: { db?: SupabaseClient } = {},
): Promise<void> {
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Invalid communication usage.");
  const db = opts.db ?? createSupabaseServiceRoleClient();
  const { data, error } = await db.rpc("settle_number_credit_quantity", {
    p_owner: ownerUserId,
    p_key: idempotencyKey.trim(),
    p_quantity: quantity,
  });
  if (error || data !== true) throw new Error("Communication credit settlement failed.");
}

/** Read-only balance (never applies a month rollover; the next reserve does). */
export async function getNumberCreditBalance(
  ownerUserId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<NumberCreditBalance> {
  const { data, error } = await db.rpc("number_credit_snapshot", {
    p_owner: ownerUserId,
    p_included_cents: NUMBER_INCLUDED_CREDIT_CENTS,
    p_apply: false,
  });
  if (error || !data) throw new NumberBillingError("unavailable", 503, "Your message credit could not be loaded.");
  const snap = data as Record<string, unknown>;
  const cents = (k: string) => {
    const n = snap[k];
    if (!Number.isSafeInteger(n) || (n as number) < 0) {
      throw new NumberBillingError("unavailable", 503, "Your message credit could not be verified.");
    }
    return n as number;
  };
  const includedCents = cents("included_remaining_cents");
  const purchasedCents = cents("purchased_cents");
  return {
    includedCents,
    purchasedCents,
    totalCents: includedCents + purchasedCents,
    resetsAt: String(snap.next_reset),
    subscriptionStatus: typeof snap.subscription_status === "string" ? snap.subscription_status : null,
  };
}

/* ------------------------------------------------------------------------------------------
 * Buying credit: one-time hosted Checkout, $5-$500 whole dollars, never auto-recharged.
 * ---------------------------------------------------------------------------------------- */

export async function createNumberCreditCheckout(
  db: SupabaseClient,
  stripe: Stripe,
  input: {
    userId: string;
    email: string;
    role: NumberOwnerRole;
    purchaseId: string;
    creditCents: number;
    origin: string;
    returnPath?: unknown;
  },
): Promise<{ url: string; purchaseId: string }> {
  if (!isValidCommsCreditAmountCents(input.creditCents)) {
    throw new NumberBillingError("invalid", 400, "Enter a whole-dollar amount from $5 to $500.");
  }
  if (!(await numberServiceEntitled(input.userId, db))) {
    throw new NumberBillingError("not_subscribed", 409, "Subscribe to a PropLane Number before adding credit.");
  }
  await assertTestWorkspaceProviderEffectAllowed({
    userId: input.userId,
    kind: "payment",
    summary: "Number credit checkout refused for a test workspace.",
    db,
  });
  const { error: insertError } = await db.from("number_credit_purchases").insert({
    id: input.purchaseId,
    owner_user_id: input.userId,
    credit_cents: input.creditCents,
  });
  if (insertError && insertError.code !== "23505") {
    throw new NumberBillingError("unavailable", 503, "Could not start the credit purchase.");
  }
  // The row must be THIS owner's, for THIS amount: another user's purchase id matches nothing here.
  const { data: purchase } = await db
    .from("number_credit_purchases")
    .select("credit_cents, stripe_session_id, status, created_at")
    .eq("id", input.purchaseId)
    .eq("owner_user_id", input.userId)
    .maybeSingle();
  if (!purchase || purchase.credit_cents !== input.creditCents) {
    throw new NumberBillingError("invalid", 400, "Credit purchase does not match this account.");
  }
  if (purchase.status !== "pending") {
    throw new NumberBillingError("invalid", 409, "This purchase has already been processed. Refresh your balance.");
  }
  if (Date.now() - Date.parse(purchase.created_at) > 23 * 60 * 60 * 1000) {
    throw new NumberBillingError("invalid", 409, "This checkout attempt expired. Start a new purchase.");
  }
  if (purchase.stripe_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(purchase.stripe_session_id);
    if (existing.status !== "open" || !existing.url) {
      throw new NumberBillingError("invalid", 409, "This checkout is no longer open. Refresh your balance.");
    }
    return { url: existing.url, purchaseId: input.purchaseId };
  }
  const customer = await ensureNumberOwnerStripeCustomerId(stripe, db, input.userId, input.email, input.role);
  const path = safeNumberReturnPath(input.returnPath, `/${input.role}`);
  const done = new URL(path, input.origin);
  done.searchParams.set("number_credit", input.purchaseId);
  const metadata = {
    purpose: NUMBER_CREDIT_PURPOSE,
    owner_user_id: input.userId,
    purchase_id: input.purchaseId,
    credit_cents: String(input.creditCents),
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer,
      client_reference_id: input.userId,
      payment_method_types: ["card"],
      metadata,
      payment_intent_data: { metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: input.creditCents,
            product_data: {
              name: "PropLane Number message credit",
              description: "One-time credit for texts and AI replies on your number. Never expires. No automatic recharge.",
            },
          },
        },
      ],
      success_url: done.toString(),
      cancel_url: new URL(path, input.origin).toString(),
    },
    { idempotencyKey: `number-credit:${input.userId}:${input.purchaseId}` },
  );
  if (!session.url) throw new NumberBillingError("unavailable", 503, "Checkout could not be opened.");
  const { error: saveError } = await db
    .from("number_credit_purchases")
    .update({ stripe_session_id: session.id })
    .eq("id", input.purchaseId)
    .eq("owner_user_id", input.userId);
  if (saveError) throw new NumberBillingError("unavailable", 503, "Checkout could not be saved. Retry this purchase.");
  return { url: session.url, purchaseId: input.purchaseId };
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  const pi = session.payment_intent;
  return (typeof pi === "string" ? pi : pi?.id)?.trim() || null;
}

/** Signed webhook only. Returns false when this session is not a number-credit purchase or was already applied. */
export async function fulfillNumberCreditPurchase(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  eventId: string,
): Promise<boolean> {
  if (session.metadata?.purpose !== NUMBER_CREDIT_PURPOSE) return false;
  if (session.payment_status !== "paid") return false;
  const owner = session.metadata.owner_user_id?.trim();
  const purchase = session.metadata.purchase_id?.trim();
  const credit = Number(session.metadata.credit_cents);
  const paymentId = paymentIntentId(session);
  if (
    !owner ||
    !purchase ||
    !paymentId ||
    session.mode !== "payment" ||
    session.currency !== "usd" ||
    !isValidCommsCreditAmountCents(credit) ||
    session.amount_subtotal !== credit ||
    session.amount_total !== credit ||
    session.client_reference_id !== owner ||
    (session.total_details?.amount_discount ?? 0) !== 0
  ) {
    throw new NumberCreditValidationError("Number credit payment did not match the purchase.");
  }
  const { data: stored, error } = await db
    .from("number_credit_purchases")
    .select("owner_user_id")
    .eq("id", purchase)
    .maybeSingle();
  if (error) throw new Error("Number credit ownership could not be verified.");
  if (!stored || String(stored.owner_user_id ?? "").trim() !== owner) {
    throw new NumberCreditValidationError("Number credit payment did not match a purchase on this account.");
  }
  const { data, error: rpcError } = await db.rpc("fulfill_number_credit_purchase", {
    p_purchase: purchase,
    p_owner: owner,
    p_session: session.id,
    p_payment_intent: paymentId,
    p_credit: credit,
    p_event: eventId,
  });
  if (rpcError) {
    if (/mismatch/i.test(rpcError.message ?? "")) {
      throw new NumberCreditValidationError("Number credit payment did not match a purchase on this account.");
    }
    throw new Error("Number credit could not be added.");
  }
  return data === true;
}

/** Refund/dispute reversal. Returns false (never throws for "not found") when the payment is not a number purchase. */
export async function reverseNumberCreditForPaymentIntent(
  db: SupabaseClient,
  paymentIntent: string | null | undefined,
  eventId: string,
  opts: { dispute?: boolean; loadCharge: () => Promise<Pick<Stripe.Charge, "amount_refunded">> },
): Promise<boolean> {
  const paymentId = (paymentIntent ?? "").trim();
  if (!paymentId) return false;
  const { data: purchase, error } = await db
    .from("number_credit_purchases")
    .select("credit_cents")
    .eq("stripe_payment_intent_id", paymentId)
    .maybeSingle();
  if (error) throw new Error("Number credit reversal could not be verified.");
  if (!purchase) return false;
  const dispute = opts.dispute === true;
  const reversed = dispute
    ? purchase.credit_cents
    : Math.min(purchase.credit_cents, (await opts.loadCharge()).amount_refunded);
  const { data, error: rpcError } = await db.rpc("reverse_number_credit_purchase", {
    p_payment_intent: paymentId,
    p_reversed: reversed,
    p_event: eventId,
    p_reason: dispute ? "dispute" : "refund",
  });
  if (rpcError) throw new Error("Number credit reversal failed.");
  return data === true;
}
