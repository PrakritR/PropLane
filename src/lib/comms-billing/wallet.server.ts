import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import {
  includedAllowanceCents,
  normalizeCommsPlanTier,
  type CommsPlanTier,
} from "./allowances";
import { unitPriceCentsForMeter, type CommsBillingMeter } from "./rates";

export type CommsWallet = {
  tier: CommsPlanTier;
  allowanceCents: number;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  remainingCents: number;
  nextAllowanceCents: number;
  periodStart: string;
  periodEnd: string;
  paused: boolean;
};

export async function commsPlanBudget(owner: string) {
  const plan = await getEffectiveManagerSkuTier(owner);
  if (!plan.ok)
    throw new Error("We could not verify your communication plan. Try again.");
  const tier = normalizeCommsPlanTier(plan.tier);
  return {
    tier,
    allowance: includedAllowanceCents(tier) ?? 0,
    legacy: { free: 250, pro: 1500, business: 15000 }[tier],
  };
}

export async function loadCommsWallet(
  db: SupabaseClient,
  owner: string,
): Promise<CommsWallet> {
  const budget = await commsPlanBudget(owner);
  const { data, error } = await db.rpc("comms_wallet_snapshot", {
    p_owner: owner,
    p_allowance: budget.allowance,
    p_legacy_allowance: budget.legacy,
    p_apply: false,
  });
  if (error || !data)
    throw new Error("We could not load your communication credit. Try again.");
  const cents = (key: string) => {
    const n = data[key];
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("Communication credit could not be verified.");
    return n as number;
  };
  const included = cents("included_remaining_cents");
  const purchased = cents("purchased_remaining_cents");
  return {
    tier: budget.tier,
    allowanceCents: cents("allowance_cents"),
    includedRemainingCents: included,
    purchasedRemainingCents: purchased,
    remainingCents: included + purchased,
    nextAllowanceCents: cents("next_allowance_cents"),
    periodStart: data.period_start,
    periodEnd: data.period_end,
    paused: data.paused === true,
  };
}

export type CommsReservationInput = {
  managerUserId: string;
  meter: CommsBillingMeter;
  quantity?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};
export type CommsReservation =
  | { allowed: true; duplicate: boolean; state: "reserved" | "settled" }
  | { allowed: false; reason: string };

/** Caller must already have authorized the action and its billing owner. */
export async function reserveCommsCredit(
  db: SupabaseClient,
  input: CommsReservationInput,
  allowUnfunded = false,
): Promise<CommsReservation> {
  const budget = await commsPlanBudget(input.managerUserId);
  const quantity = input.quantity ?? 1;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000 ||
    !input.idempotencyKey.trim()
  ) {
    throw new Error("Invalid communication usage.");
  }
  const { data, error } = await db.rpc("reserve_comms_credit", {
    p_owner: input.managerUserId,
    p_allowance: budget.allowance,
    p_legacy_allowance: budget.legacy,
    p_key: input.idempotencyKey,
    p_meter: input.meter,
    p_quantity: quantity,
    p_unit_cents: unitPriceCentsForMeter(input.meter),
    p_metadata: input.metadata ?? {},
    p_allow_unfunded: allowUnfunded,
  });
  if (error || !data)
    throw new Error("Communication credit could not be reserved.");
  if (data.allowed !== true)
    return {
      allowed: false,
      reason: String(data.reason ?? "usage_already_processed"),
    };
  return {
    allowed: true,
    duplicate: data.duplicate === true,
    state: data.state,
  };
}

export async function finishCommsCredit(
  db: SupabaseClient,
  owner: string,
  key: string,
  release = false,
) {
  const { data, error } = await db.rpc("finish_comms_credit", {
    p_owner: owner,
    p_key: key,
    p_release: release,
  });
  if (error || data !== true)
    throw new Error("Communication credit reconciliation failed.");
  if (!release) {
    const { maybeNotifyCommsBudgetThreshold } =
      await import("./notifications.server");
    await maybeNotifyCommsBudgetThreshold(db, owner).catch(() => undefined);
  }
}
