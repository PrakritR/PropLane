import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  verifyPlatformHoldSourceRefundHistory,
  type HeldSourceRow,
} from "@/lib/platform-hold-release.server";

type ReservedOwnerRecovery = {
  attempt_key: string;
  hold_id: string;
  owner_user_id: string;
  source_charge_id: string;
  source_payment_intent_id: string;
  source_net_cents: number;
};

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

/** Never infer availability from capture time or a local clock. */
export async function verifiedCapturedChargeAvailability(
  stripe: Stripe, charge: Stripe.Charge,
): Promise<{ availableOn: string; balanceTransactionId: string; status: string } | null> {
  const balanceId = idOf(charge.balance_transaction);
  if (!balanceId) return null;
  const balance = await stripe.balanceTransactions.retrieve(balanceId);
  if (balance.id !== balanceId || balance.currency !== "usd" ||
      balance.amount !== charge.amount || idOf(balance.source) !== charge.id ||
      !["charge", "payment"].includes(balance.type) ||
      !Number.isSafeInteger(balance.fee) || balance.fee < 0 ||
      !Number.isSafeInteger(balance.net) || balance.net !== balance.amount - balance.fee ||
      !Number.isSafeInteger(balance.available_on) || balance.available_on <= 0) {
    throw new Error("Captured charge availability differs from its balance transaction.");
  }
  return { availableOn: new Date(balance.available_on * 1000).toISOString(),
    balanceTransactionId: balance.id, status: balance.status };
}

/** A reservation repays its creditor only from fresh, available source cash. */
export async function settleClearedPlatformOwnerRecovery(
  db: SupabaseClient, stripe: Stripe,
  opts: { ownerUserId: string; holdId?: string },
): Promise<{ settled: number; pending: number }> {
  let query = db.from("platform_source_consumption_legs")
    .select("attempt_key,hold_id,owner_user_id,source_charge_id,source_payment_intent_id,source_net_cents")
    .eq("owner_user_id", opts.ownerUserId)
    .eq("kind", "owner_debt_recovery").eq("status", "reserved");
  if (opts.holdId) query = query.eq("hold_id", opts.holdId);
  const { data, error } = await query;
  if (error) throw new Error("Could not load reserved owner recovery sources.");
  let settled = 0;
  let pending = 0;
  for (const leg of (data ?? []) as ReservedOwnerRecovery[]) {
    if (!leg.attempt_key || !leg.hold_id || leg.owner_user_id !== opts.ownerUserId ||
        !leg.source_charge_id || !leg.source_payment_intent_id ||
        !Number.isSafeInteger(leg.source_net_cents) || leg.source_net_cents <= 0) {
      throw new Error("Owner recovery reservation has incomplete source identity.");
    }
    const { data: hold, error: holdError } = await db.from("platform_payment_holds")
      .select("id,owner_user_id,owner_role,source,source_id,amount_cents,status,stripe_charge_id,original_amount_cents,source_charge_gross_cents,source_payment_intent_id,source_verified_at")
      .eq("id", leg.hold_id).maybeSingle();
    if (holdError || !hold || hold.owner_user_id !== opts.ownerUserId ||
        hold.owner_role !== "manager" || hold.stripe_charge_id !== leg.source_charge_id ||
        hold.source_payment_intent_id !== leg.source_payment_intent_id) {
      throw new Error("Owner recovery hold differs from reserved captured source.");
    }
    const charge = await verifyPlatformHoldSourceRefundHistory(db, stripe, hold as HeldSourceRow);
    const availability = await verifiedCapturedChargeAvailability(stripe, charge);
    if (!availability) { pending += 1; continue; }
    if (availability.status !== "available" || Date.parse(availability.availableOn) > Date.now()) {
      pending += 1;
      continue;
    }
    const { data: changed, error: settleError } = await db.rpc("settle_platform_owner_recovery", {
      p_attempt: leg.attempt_key,
      p_charge: leg.source_charge_id,
      p_payment_intent: leg.source_payment_intent_id,
      p_balance_transaction: availability.balanceTransactionId,
      p_available_on: availability.availableOn,
      p_attested_at: new Date().toISOString(),
    });
    if (settleError || typeof changed !== "boolean") {
      throw new Error("Owner recovery clearing could not be durably settled.");
    }
    if (changed) settled += 1;
  }
  return { settled, pending };
}

/** Existing daily finance cron retries only persisted, unresolved offsets. */
export async function reconcileReservedPlatformOwnerRecovery(
  db: SupabaseClient, stripe: Stripe,
): Promise<{ scanned: number; settled: number; pending: number; truncated: boolean; errors: string[] }> {
  const { data, error } = await db.from("platform_source_consumption_legs")
    .select("owner_user_id,hold_id")
    .eq("kind", "owner_debt_recovery").eq("status", "reserved")
    .order("created_at", { ascending: true }).limit(201);
  if (error) throw new Error("Could not load pending owner recovery for reconciliation.");
  const rows = (data ?? []).slice(0, 200) as Array<{ owner_user_id: string; hold_id: string }>;
  const pairs = new Set(rows.map((row) => `${row.owner_user_id}:${row.hold_id}`));
  const result = { scanned: rows.length, settled: 0, pending: 0,
    truncated: (data ?? []).length > 200, errors: [] as string[] };
  for (const pair of pairs) {
    const [ownerUserId, holdId] = pair.split(":");
    try {
      const outcome = await settleClearedPlatformOwnerRecovery(db, stripe, { ownerUserId, holdId });
      result.settled += outcome.settled;
      result.pending += outcome.pending;
    } catch (reason) {
      result.errors.push(`${pair}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return result;
}

type UnhydratedCentralSourceMirror = {
  source_hold_id: string;
  platform_payment_holds: {
    id: string; owner_user_id: string; owner_role: string; source: string;
    source_id: string; amount_cents: number; status: string;
    source_allocation_mode: string; source_verified_at: string;
    stripe_charge_id: string; source_payment_intent_id: string;
    source_charge_gross_cents: number; source_principal_cents: number;
    original_amount_cents: number; source_fee_payer: string;
    source_components: unknown;
  };
};

/** Retry only classified central mirrors whose provider availability was absent at capture. */
export async function reconcileUnhydratedCentralSourceMirrors(
  db: SupabaseClient, stripe: Stripe,
): Promise<{ scanned: number; hydrated: number; pending: number; truncated: boolean; errors: string[] }> {
  const { data, error } = await db.from("proplane_balance_entries")
    .select("source_hold_id,platform_payment_holds!inner(id,owner_user_id,owner_role,source,source_id,amount_cents,status,source_allocation_mode,source_verified_at,stripe_charge_id,source_payment_intent_id,source_charge_gross_cents,source_principal_cents,original_amount_cents,source_fee_payer,source_components)")
    .eq("kind", "resident_payment")
    .in("platform_payment_holds.source", ["application_fee", "household_charge"])
    .is("available_on", null).order("created_at", { ascending: true }).limit(201);
  if (error) throw new Error("Could not load unhydrated central income mirrors.");
  const rows = ((data ?? []).slice(0, 200)) as unknown as UnhydratedCentralSourceMirror[];
  const result = { scanned: rows.length, hydrated: 0, pending: 0,
    truncated: (data ?? []).length > 200, errors: [] as string[] };
  const visited = new Set<string>();
  for (const row of rows) {
    const hold = row.platform_payment_holds;
    if (!hold || !row.source_hold_id || visited.has(row.source_hold_id)) continue;
    visited.add(row.source_hold_id);
    try {
      if (hold.id !== row.source_hold_id || hold.owner_role !== "manager" ||
          !["application_fee", "household_charge"].includes(hold.source) ||
          hold.source_allocation_mode !== "hold" ||
          !hold.source_verified_at || !hold.stripe_charge_id ||
          !hold.source_payment_intent_id || !Array.isArray(hold.source_components)) {
        throw new Error("Classified central mirror lacks immutable captured source terms.");
      }
      const charge = await verifyPlatformHoldSourceRefundHistory(db, stripe, hold as HeldSourceRow);
      const availability = await verifiedCapturedChargeAvailability(stripe, charge);
      if (!availability) { result.pending += 1; continue; }
      const { data: credited, error: creditError } = await db.rpc("credit_platform_income_with_recovery", {
        p_owner: hold.owner_user_id, p_source: hold.source, p_source_id: hold.source_id,
        p_charge: hold.stripe_charge_id, p_payment_intent: hold.source_payment_intent_id,
        p_charge_gross: hold.source_charge_gross_cents,
        p_principal: hold.source_principal_cents,
        p_original_net: hold.original_amount_cents,
        p_fee_payer: hold.source_fee_payer, p_components: hold.source_components,
        p_available_on: availability.availableOn,
      });
      const outcome = Array.isArray(credited) ? credited[0] : credited;
      if (creditError || outcome?.hold_id !== hold.id || outcome?.credited !== false) {
        throw new Error("Classified central mirror availability could not be replayed.");
      }
      result.hydrated += 1;
    } catch (reason) {
      result.errors.push(`${row.source_hold_id}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  return result;
}
