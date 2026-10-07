import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { connectAccountReadyForAchPayouts } from "@/lib/stripe-connect";
import { getStripe } from "@/lib/stripe";
import { readFrozenDisputeChargeIds } from "@/lib/vendor-banking/disputes.server";

export type HeldSourceRow = {
  id: string;
  owner_user_id: string;
  owner_role: "manager" | "vendor";
  source: string;
  source_id: string;
  amount_cents: number;
  status: string;
  stripe_charge_id: string | null;
  original_amount_cents: number | null;
  source_charge_gross_cents: number | null;
  source_payment_intent_id: string | null;
  source_verified_at: string | null;
};

type TransferAttempt = {
  id: string;
  hold_id: string;
  attempt_key: string;
  owner_user_id: string;
  destination_account_id: string;
  source_charge_id: string;
  amount_cents: number;
  component_breakdown: Array<{ source_id: string; recipient_net_cents: number }>;
  status: "reserved" | "created" | "failed";
  stripe_transfer_id: string | null;
  created_at: string;
};

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

async function readyOwnedDestination(
  db: SupabaseClient, stripe: Stripe, ownerUserId: string,
): Promise<string | null> {
  const { data, error } = await db.from("profiles")
    .select("stripe_connect_account_id").eq("id", ownerUserId).maybeSingle();
  if (error) throw new Error("Could not verify saved payout account ownership.");
  const accountId = String(data?.stripe_connect_account_id ?? "").trim();
  if (!accountId) return null;
  // A missing/inaccessible account must not erase the saved identity. The
  // owner explicitly relinks it through the in-app bank flow.
  const account = await stripe.accounts.retrieve(accountId);
  if (account.id !== accountId || account.metadata?.axis_user_id !== ownerUserId) {
    throw new Error("Saved payout account does not match its owner.");
  }
  return connectAccountReadyForAchPayouts(account) ? account.id : null;
}

export async function verifyPlatformHoldSourceRefundHistory(
  db: SupabaseClient, stripe: Stripe, hold: HeldSourceRow,
): Promise<Stripe.Charge> {
  if (!hold.stripe_charge_id || !hold.source_payment_intent_id ||
      !hold.source_charge_gross_cents || !hold.original_amount_cents ||
      !hold.source_verified_at || hold.amount_cents <= 0) {
    throw new Error("Platform hold has no verified source provenance.");
  }
  const charge = await stripe.charges.retrieve(hold.stripe_charge_id);
  if (!charge.paid || charge.status !== "succeeded" || charge.currency !== "usd" ||
      charge.amount !== hold.source_charge_gross_cents || charge.disputed ||
      idOf(charge.payment_intent) !== hold.source_payment_intent_id) {
    throw new Error("Platform hold source charge needs refund or payment review.");
  }
  const { data, error } = await db.from("platform_hold_refund_attempts")
    .select("status,stripe_refund_id,terminal_provider_status,gross_cents,hold_debit_cents")
    .eq("hold_id", hold.id);
  if (error) throw new Error("Platform hold refund history could not be verified.");
  const attempts = (data ?? []) as Array<{
    status: string; stripe_refund_id: string | null; terminal_provider_status: string | null;
    gross_cents: number; hold_debit_cents: number;
  }>;
  if (attempts.some((attempt) => attempt.status === "reserved")) {
    throw new Error("Platform hold has an unresolved refund reservation.");
  }
  const succeeded = attempts.filter((attempt) => attempt.status === "succeeded");
  const terminal = attempts.filter((attempt) => attempt.status === "failed");
  const refundedGross = succeeded.reduce((sum, attempt) => sum + attempt.gross_cents, 0);
  const debitedNet = succeeded.reduce((sum, attempt) => sum + attempt.hold_debit_cents, 0);
  const { data: settledConsumption, error: consumptionError } = await db
    .from("platform_source_consumption_legs")
    .select("source_net_cents").eq("hold_id", hold.id).eq("status", "settled");
  if (consumptionError) throw new Error("Platform source consumption could not be verified.");
  const consumedNet = (settledConsumption ?? []).reduce((sum, leg) => {
    if (!Number.isSafeInteger(leg.source_net_cents) || leg.source_net_cents <= 0) {
      throw new Error("Platform source consumption has an invalid amount.");
    }
    return sum + leg.source_net_cents;
  }, 0);
  if (refundedGross !== charge.amount_refunded ||
      !Number.isSafeInteger(consumedNet) ||
      hold.original_amount_cents - debitedNet - consumedNet !== hold.amount_cents ||
      succeeded.some((attempt) => !attempt.stripe_refund_id) ||
      terminal.some((attempt) => !attempt.stripe_refund_id ||
        !["failed", "canceled"].includes(attempt.terminal_provider_status ?? ""))) {
    throw new Error("Platform hold refund accounting differs from its charge.");
  }
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  if (refunds.has_more || refunds.data.length !== succeeded.length + terminal.length) {
    throw new Error("Platform hold source has unmapped refund history.");
  }
  const byId = new Map([...succeeded, ...terminal].map((attempt) => [attempt.stripe_refund_id, attempt]));
  for (const refund of refunds.data) {
    const attempt = byId.get(refund.id);
    if (!attempt || refund.status !== (attempt.status === "succeeded" ? "succeeded" : attempt.terminal_provider_status) ||
        refund.amount !== attempt.gross_cents ||
        idOf(refund.charge) !== charge.id) {
      throw new Error("Platform hold refund provider leg needs review.");
    }
  }
  return charge;
}

/**
 * Release an owner-scoped, verified source hold to the saved ready Connect
 * account. Both receipt fulfillment and account.updated call this; the DB
 * reservation wins before Stripe, so their concurrent calls share one exact
 * attempt and source_transaction. Unknown Stripe outcomes retain that attempt.
 */
export async function releaseVerifiedPlatformHoldsForOwner(
  db: SupabaseClient,
  opts: { ownerUserId: string; holdId?: string; stripe?: Stripe; reservedAttemptOnly?: boolean },
): Promise<{ transferred: number; pending: number }> {
  const stripe = opts.stripe ?? getStripe();
  let holdQuery = db.from("platform_payment_holds")
    .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
    .eq("owner_user_id", opts.ownerUserId).eq("status", "classified_held");
  if (opts.holdId) holdQuery = holdQuery.eq("id", opts.holdId);
  const { data, error } = await holdQuery;
  if (error) throw new Error(error.message);
  const holds = (data ?? []) as HeldSourceRow[];
  const { data: pendingAttempts, error: attemptError } = await db.from("platform_hold_transfer_attempts")
    .select("id,hold_id,attempt_key,owner_user_id,destination_account_id,source_charge_id,amount_cents,component_breakdown,status,stripe_transfer_id,created_at")
    .eq("owner_user_id", opts.ownerUserId).eq("status", "reserved");
  if (attemptError) throw new Error("Could not load reserved hold transfers.");
  const attemptsByHold = new Map((pendingAttempts ?? []).map((row) => [String(row.hold_id), row as TransferAttempt]));
  // Money frozen by an open dispute must not leave the platform hold: a NEW release is skipped
  // (stays visible as held) while its charge is disputed. An already-reserved attempt may still
  // finish, because its transfer may already exist at Stripe.
  const frozenChargeIds = holds.some((hold) => hold.owner_role === "vendor")
    ? await readFrozenDisputeChargeIds(db, opts.ownerUserId)
    : new Set<string>();
  let newDestination: string | null | undefined;
  let transferred = 0;
  let pending = 0;
  for (const hold of holds) {
    if (!hold.source_verified_at) {
      pending += 1; // visible held money, still source-review gated
      continue;
    }
    const previous = attemptsByHold.get(hold.id);
    if (opts.reservedAttemptOnly && !previous) continue;
    if (!previous && hold.stripe_charge_id && frozenChargeIds.has(hold.stripe_charge_id)) {
      pending += 1;
      continue;
    }
    await verifyPlatformHoldSourceRefundHistory(db, stripe, hold);
    let destination: string | null;
    if (previous) {
      // An accepted transfer may have lost its response before the owner
      // relinked a bank. Retries must use the original destination and key.
      const account = await stripe.accounts.retrieve(previous.destination_account_id);
      if (account.id !== previous.destination_account_id ||
          account.metadata?.axis_user_id !== opts.ownerUserId) {
        throw new Error("Reserved platform transfer destination needs owner review.");
      }
      destination = previous.destination_account_id;
    } else {
      if (newDestination === undefined) {
        newDestination = await readyOwnedDestination(db, stripe, opts.ownerUserId);
      }
      destination = newDestination;
    }
    if (!destination) { pending += 1; continue; }
    const { data: reserved, error: claimError } = await db.rpc("reserve_platform_hold_transfer", {
      p_hold: hold.id, p_owner: opts.ownerUserId,
      p_attempt: `platform-hold:${hold.id}:${randomUUID()}`,
      p_destination: destination, p_charge: hold.stripe_charge_id,
    });
    // This exact SQL result follows source/component conservation and means
    // every remaining cent belongs to an earlier transfer or recovery claim.
    if (claimError?.code === "P0001" &&
        claimError.message === "platform hold has no releasable residual") {
      pending += 1;
      continue;
    }
    if (claimError || !reserved) throw new Error("Could not reserve platform hold release.");
    const attempt = reserved as TransferAttempt;
    const breakdownTotal = Array.isArray(attempt.component_breakdown)
      ? attempt.component_breakdown.reduce((sum, component) => {
          if (!component.source_id || !Number.isSafeInteger(component.recipient_net_cents) ||
              component.recipient_net_cents < 0) return Number.NaN;
          return sum + component.recipient_net_cents;
        }, 0)
      : Number.NaN;
    if (attempt.owner_user_id !== opts.ownerUserId || attempt.hold_id !== hold.id ||
        attempt.source_charge_id !== hold.stripe_charge_id ||
        !Number.isSafeInteger(attempt.amount_cents) || attempt.amount_cents <= 0 ||
        attempt.amount_cents > hold.amount_cents || breakdownTotal !== attempt.amount_cents ||
        (previous && (attempt.id !== previous.id || attempt.destination_account_id !== previous.destination_account_id))) {
      throw new Error("Platform transfer attempt changed immutable source or destination.");
    }
    if (!previous && attempt.destination_account_id !== destination) {
      // Another worker may have reserved the source with a different saved
      // account after this snapshot. Reconcile that exact attempt next run;
      // never redirect it to this worker's destination.
      throw new Error("Concurrent platform transfer destination needs retry.");
    }
    if (attempt.status === "created") continue;
    // Stripe retains idempotency keys for at least 24 hours. Never create a
    // second transfer using an aged/ambiguous key without provider review.
    const attemptAgeMs = Date.now() - Date.parse(attempt.created_at);
    // created_at is the database clock; tolerate small app/db clock skew.
    if (!Number.isFinite(attemptAgeMs) || attemptAgeMs < -5 * 60 * 1000 || attemptAgeMs > 20 * 60 * 60 * 1000) {
      throw new Error("Platform transfer attempt requires provider reconciliation.");
    }
    const transfer = await stripe.transfers.create({
      amount: attempt.amount_cents,
      currency: "usd",
      destination: attempt.destination_account_id,
      source_transaction: attempt.source_charge_id,
      metadata: { platform_hold_id: hold.id, platform_hold_attempt: attempt.id,
        source: hold.source, source_id: hold.source_id },
    }, { idempotencyKey: attempt.attempt_key });
    if (transfer.amount !== attempt.amount_cents || transfer.currency !== "usd" ||
        idOf(transfer.destination) !== attempt.destination_account_id ||
        idOf(transfer.source_transaction) !== attempt.source_charge_id) {
      throw new Error("Stripe transfer does not match the reserved platform source.");
    }
    // The source can be externally refunded after the earlier readiness read.
    // Keep an accepted transfer reserved/unknown instead of claiming released
    // money until its current charge/refund legs still match this allocation.
    await verifyPlatformHoldSourceRefundHistory(db, stripe, hold);
    const { error: finishError } = await db.rpc("finish_platform_hold_transfer", {
      p_hold: hold.id,p_owner: opts.ownerUserId,p_attempt: attempt.attempt_key,p_transfer: transfer.id,
    });
    if (finishError) throw new Error("Could not finalize source-backed platform transfer.");
    transferred += 1;
  }
  return { transferred, pending };
}

/** Daily retry of only durable unknown provider outcomes. The existing
 * reservation supplies the destination, source Charge, amount, and Stripe
 * idempotency key; no new payout is claimed by this scan. */
export async function reconcileReservedPlatformHoldTransfers(
  db: SupabaseClient, stripe: Stripe,
): Promise<{ scanned: number; transferred: number; pending: number; truncated: boolean; errors: string[] }> {
  const { data, error } = await db.from("platform_hold_transfer_attempts")
    .select("owner_user_id,hold_id")
    .eq("status", "reserved").order("created_at", { ascending: true }).limit(201);
  if (error) throw new Error("Could not load reserved platform hold transfers.");
  const rows = (data ?? []).slice(0, 200) as Array<{ owner_user_id: string; hold_id: string }>;
  const result = { scanned: rows.length, transferred: 0, pending: 0,
    truncated: (data ?? []).length > 200, errors: [] as string[] };
  const seen = new Set<string>();
  for (const row of rows) {
    const pair = `${row.owner_user_id}:${row.hold_id}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    if (!row.owner_user_id || !row.hold_id) {
      result.errors.push(`${pair}: incomplete reserved transfer identity`);
      continue;
    }
    try {
      const outcome = await releaseVerifiedPlatformHoldsForOwner(db, {
        ownerUserId: row.owner_user_id, holdId: row.hold_id,
        reservedAttemptOnly: true, stripe,
      });
      result.transferred += outcome.transferred;
      result.pending += outcome.pending;
    } catch (reason) {
      result.errors.push(`${pair}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return result;
}
