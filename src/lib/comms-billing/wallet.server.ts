import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import {
  includedAllowanceCents,
  normalizeCommsPlanTier,
  type CommsPlanTier,
} from "./allowances";
import { isCommsCreditPoolEnabled, unitPriceCentsForMeter, type CommsBillingMeter } from "./rates";

export type CommsWallet = {
  tier: CommsPlanTier;
  /** The workspace this balance belongs to. Credit is never account-wide. */
  workspaceId: string;
  /** Included monthly credit lands on the owner's default workspace only. */
  isDefaultWorkspace: boolean;
  allowanceCents: number;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  remainingCents: number;
  nextAllowanceCents: number;
  periodStart: string;
  periodEnd: string;
  paused: boolean;
};

/**
 * The migration-month grace ended (PLAN-0920-1400): this used to read HIGHER
 * than the plan's own allowance so an existing manager kept their old, larger
 * monthly credit for one cutover month. It now equals the plan's own included
 * allowance (`RATE_CARD.<tier>.commsIncludedAllowanceCents`), so
 * `greatest(allowance, legacy)` in `comms_wallet_snapshot` is a no-op and the
 * plan's own allowance is always what applies — a Business account always
 * reads its current rate-card credit, never a stale migration-era override.
 */
function legacyAllowanceCentsForTier(tier: CommsPlanTier): number {
  return includedAllowanceCents(tier) ?? 0;
}

export function commsPlanBudgetForTier(tier: CommsPlanTier) {
  return {
    tier,
    allowance: includedAllowanceCents(tier) ?? 0,
    legacy: legacyAllowanceCentsForTier(tier),
  };
}

export async function commsPlanBudget(owner: string) {
  const plan = await getEffectiveManagerSkuTier(owner);
  if (!plan.ok)
    throw new Error("We could not verify your communication plan. Try again.");
  return commsPlanBudgetForTier(normalizeCommsPlanTier(plan.tier));
}

export type CommsWalletTotals = {
  allowanceCents: number;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  paused: boolean;
};

function walletTotalsFromSnapshot(data: unknown): CommsWalletTotals | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  const cents = (key: string) => {
    const n = row[key];
    return Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null;
  };
  const allowance = cents("allowance_cents");
  const included = cents("included_remaining_cents");
  const purchased = cents("purchased_remaining_cents");
  if (allowance === null || included === null || purchased === null) return null;
  return {
    allowanceCents: allowance,
    includedRemainingCents: included,
    purchasedRemainingCents: purchased,
    paused: row.paused === true,
  };
}

/**
 * Staff-only bulk read of many owners' wallets in one round trip. Read-only:
 * no account or workspace is created and no period is applied. Each owner is
 * read on their DEFAULT workspace, the one that carries the plan's included
 * credit. An owner whose snapshot could not be computed is absent from the
 * result rather than shown as zero.
 */
export async function loadCommsWalletTotals(
  db: SupabaseClient,
  owners: { managerUserId: string; tier: CommsPlanTier }[],
): Promise<Map<string, CommsWalletTotals>> {
  const totals = new Map<string, CommsWalletTotals>();
  const CHUNK = 200;
  for (let i = 0; i < owners.length; i += CHUNK) {
    const chunk = owners.slice(i, i + CHUNK);
    const { data, error } = await db.rpc("comms_wallet_snapshots", {
      p_requests: chunk.map((owner) => {
        const budget = commsPlanBudgetForTier(owner.tier);
        return {
          owner: owner.managerUserId,
          allowance: budget.allowance,
          legacy_allowance: budget.legacy,
        };
      }),
    });
    if (error) continue;
    for (const row of (data ?? []) as {
      manager_user_id: string;
      snapshot: unknown;
    }[]) {
      const parsed = walletTotalsFromSnapshot(row.snapshot);
      if (parsed) totals.set(String(row.manager_user_id), parsed);
    }
  }
  return totals;
}

/**
 * The workspace whose wallet a caller means when it named none. Owner-scoped:
 * `ensure_default_portal_workspace` creates or finds this owner's default
 * workspace, never another account's.
 */
export async function resolveDefaultCommsWorkspace(
  db: SupabaseClient,
  owner: string,
): Promise<string> {
  const { data, error } = await db.rpc("ensure_default_portal_workspace", {
    p_owner: owner,
  });
  const workspaceId = String(data ?? "").trim();
  if (error || !workspaceId)
    throw new Error("We could not load your communication credit. Try again.");
  return workspaceId;
}

/**
 * The workspace a vendor work-order conversation belongs to, via its
 * property. Returns null — never the owner's default workspace — when it
 * cannot be placed, so a caller refuses the reservation instead of silently
 * crediting the wrong workspace's wallet (W009).
 */
export async function resolveWorkspaceIdForWorkOrder(
  db: SupabaseClient,
  workOrderId: string | null | undefined,
): Promise<string | null> {
  const id = workOrderId?.trim();
  if (!id) return null;
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("property_id")
    .eq("id", id)
    .maybeSingle();
  const propertyId = String(data?.property_id ?? "").trim();
  if (error || !propertyId) return null;
  const { data: property, error: propertyError } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("id", propertyId)
    .maybeSingle();
  const workspaceId = String(property?.workspace_id ?? "").trim();
  if (propertyError || !workspaceId) return null;
  return workspaceId;
}

/**
 * The workspace that holds a given work number. Returns null — never a
 * default — when the number cannot be placed (W009).
 */
export async function resolveWorkspaceIdForWorkNumber(
  db: SupabaseClient,
  ownerUserId: string,
  phoneE164: string | null | undefined,
): Promise<string | null> {
  const phone = phoneE164?.trim();
  if (!ownerUserId.trim() || !phone) return null;
  const { data, error } = await db
    .from("manager_sms_numbers")
    .select("workspace_id")
    .eq("manager_user_id", ownerUserId)
    .eq("phone_number", phone)
    .maybeSingle();
  const workspaceId = String(data?.workspace_id ?? "").trim();
  if (error || !workspaceId) return null;
  return workspaceId;
}

export async function loadCommsWallet(
  db: SupabaseClient,
  owner: string,
  workspaceId?: string,
): Promise<CommsWallet> {
  const budget = await commsPlanBudget(owner);
  const workspace =
    workspaceId?.trim() || (await resolveDefaultCommsWorkspace(db, owner));
  const { data, error } = await db.rpc("comms_wallet_snapshot", {
    p_owner: owner,
    p_workspace: workspace,
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
    workspaceId: String(data.workspace_id ?? workspace),
    isDefaultWorkspace: data.is_default_workspace === true,
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
  /**
   * The workspace whose wallet pays. Omit only where the sending workspace is
   * genuinely unknown; the owner's default workspace then pays.
   */
  workspaceId?: string | null;
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
  if (isCommsCreditPoolEnabled()) {
    // The pool spends per WORKSPACE, never a caller-implied default: an
    // omitted workspace refuses here rather than silently falling back to the
    // owner's default workspace the way the legacy per-workspace wallet does
    // below (S27 / W009).
    const workspaceId = input.workspaceId?.trim();
    if (!workspaceId) return { allowed: false, reason: "workspace_unknown" };
    const { reserveCommsCreditPool } = await import("./pool.server");
    return reserveCommsCreditPool(
      db,
      {
        managerUserId: input.managerUserId,
        workspaceId,
        meter: input.meter,
        quantity: input.quantity,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata,
      },
      allowUnfunded,
    );
  }
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
  const workspace =
    input.workspaceId?.trim() ||
    (await resolveDefaultCommsWorkspace(db, input.managerUserId));
  const { data, error } = await db.rpc("reserve_comms_credit", {
    p_owner: input.managerUserId,
    p_workspace: workspace,
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
    throw new Error("Communication credit could not be reserved.", {
      cause: error
        ? { code: error.code, message: error.message, details: error.details, hint: error.hint }
        : "empty_result",
    });
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

/**
 * Settle or release a reservation. No workspace argument by design: the RPC
 * reads the workspace off the usage event, so credit always returns to the
 * wallet that was debited even if the sender's workspace changed since.
 */
export async function finishCommsCredit(
  db: SupabaseClient,
  owner: string,
  key: string,
  release = false,
) {
  if (isCommsCreditPoolEnabled()) {
    const { finishCommsCreditPool } = await import("./pool.server");
    await finishCommsCreditPool(db, owner, key, release);
  } else {
    const { data, error } = await db.rpc("finish_comms_credit", {
      p_owner: owner,
      p_key: key,
      p_release: release,
    });
    if (error || data !== true)
      throw new Error("Communication credit reconciliation failed.");
  }
  if (!release) {
    const { maybeNotifyCommsBudgetThreshold } =
      await import("./notifications.server");
    await maybeNotifyCommsBudgetThreshold(db, owner).catch(() => undefined);
  }
}

/**
 * Settle a bounded reservation (voice, recording) against provider-reported
 * duration. Dispatches to the pool exactly like `reserveCommsCredit` /
 * `finishCommsCredit` above; every direct `db.rpc("settle_comms_credit_quantity", …)`
 * caller should go through this instead so the flag has one place to flip.
 */
export async function settleCommsCreditQuantity(
  db: SupabaseClient,
  owner: string,
  key: string,
  quantity: number,
) {
  if (isCommsCreditPoolEnabled()) {
    const { settleCommsCreditQuantityPool } = await import("./pool.server");
    await settleCommsCreditQuantityPool(db, owner, key, quantity);
    return;
  }
  const { error } = await db.rpc("settle_comms_credit_quantity", {
    p_owner: owner,
    p_key: key,
    p_quantity: quantity,
  });
  if (error) throw new Error("Communication credit settlement failed.");
}
