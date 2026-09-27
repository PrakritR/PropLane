import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStripe } from "@/lib/stripe";
import { resolveAppOrigin } from "@/lib/app-url";
import { ensureManagerBillingCustomer } from "@/lib/manager-stripe-customer.server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { loadWorkspaces } from "@/lib/workspaces/server";
import {
  assertTestWorkspaceProviderEffectAllowed,
  captureTestWorkspaceEffectForUser,
} from "@/lib/test-workspaces/effects.server";
import { normalizeCommsPlanTier, type CommsPlanTier } from "./allowances";
import { isValidCommsCreditAmountCents } from "./credit-packs";
import { unitPriceCentsForMeter, type CommsBillingMeter } from "./rates";
import {
  CommsCreditValidationError,
  isTerminalFulfillmentError,
} from "./credit-purchase.server";

/**
 * Staging/production run this code with `COMMS_CREDIT_POOL_ENABLED` off AND
 * without the pool migration applied at all — the tables in
 * `20260927160148_comms_credit_pool.sql` simply do not exist there yet. Two
 * call sites reach pool tables unconditionally regardless of the flag (the
 * Stripe webhook's refund/dispute reconciliation, which must always TRY both
 * the legacy and pool purchase tables since either could match; and this
 * schema not existing must never break that request or the legacy refund it
 * is also reconciling). This recognizes "the table/column is not there" —
 * Postgres's own `42P01`/`42703`, and PostgREST's schema-cache-miss codes for
 * the same condition — and treats it as "no pool purchase / no pool row",
 * never a thrown error. Any OTHER error still throws.
 */
export function isMissingPoolSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: string }).code ?? "");
  const message = String((error as { message?: string }).message ?? "").toLowerCase();
  if (["42P01", "42703", "PGRST205", "PGRST202", "PGRST106", "PGRST201"].includes(code)) return true;
  return (
    message.includes("schema cache") ||
    message.includes("could not find the table") ||
    message.includes("could not find the function") ||
    (message.includes("does not exist") && (message.includes("relation") || message.includes("column") || message.includes("function")))
  );
}

/**
 * The messaging-credit pool (S27, `COMMS_CREDIT_POOL_ENABLED`). Every export
 * here is inert while that flag is off — `wallet.server.ts` is the only
 * caller, and it dispatches to this module only when the flag reads `"1"`.
 *
 * Model: credit lives per FUNDER (`comms_account_pools`), not per workspace.
 * `comms_workspace_funding` names which workspaces a funder's pool pays for
 * (and an optional monthly cap per workspace); a send picks the first eligible
 * funder of its workspace, owner first (`loadOrderedPoolFunders`), and the SQL
 * functions in `20260927160148_comms_credit_pool.sql` do the atomic spend.
 */

export type PoolFunderCandidate = { funderUserId: string; tier: CommsPlanTier };

/**
 * Owner first, then every other enabled funder of this workspace ordered by
 * how long they have funded it. A funder whose plan tier cannot be verified
 * is dropped rather than guessed — the reservation just tries the next one.
 */
export async function loadOrderedPoolFunders(
  db: SupabaseClient,
  workspaceId: string,
): Promise<PoolFunderCandidate[]> {
  const [{ data: workspace }, { data: funding, error: fundingError }] = await Promise.all([
    db.from("portal_workspaces").select("id, owner_user_id").eq("id", workspaceId).maybeSingle(),
    db
      .from("comms_workspace_funding")
      .select("funder_user_id, created_at")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true)
      .order("created_at", { ascending: true }),
  ]);
  if (fundingError) return [];
  const ownerId = workspace?.owner_user_id ? String(workspace.owner_user_id) : null;
  const ids = [...new Set((funding ?? []).map((r) => String(r.funder_user_id ?? "").trim()).filter(Boolean))];
  ids.sort((a, b) => {
    if (a === ownerId) return -1;
    if (b === ownerId) return 1;
    return 0;
  });
  const resolved = await Promise.all(
    ids.map(async (funderUserId): Promise<PoolFunderCandidate | null> => {
      const result = await getEffectiveManagerSkuTier(funderUserId);
      if (!result.ok) return null;
      return { funderUserId, tier: normalizeCommsPlanTier(result.tier) };
    }),
  );
  return resolved.filter((row): row is PoolFunderCandidate => row !== null);
}

export type PoolReservationInput = {
  managerUserId: string;
  workspaceId: string;
  meter: CommsBillingMeter;
  quantity?: number;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};
export type PoolReservation =
  | { allowed: true; duplicate: boolean; state: "reserved" | "settled"; funderUserId: string | null }
  | { allowed: false; reason: string };

/** Caller must already have authorized the action and its billing owner. */
export async function reserveCommsCreditPool(
  db: SupabaseClient,
  input: PoolReservationInput,
  allowUnfunded = false,
): Promise<PoolReservation> {
  const quantity = input.quantity ?? 1;
  if (
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000 ||
    !input.idempotencyKey.trim() ||
    !input.workspaceId.trim()
  ) {
    throw new Error("Invalid communication usage.");
  }
  const funders = await loadOrderedPoolFunders(db, input.workspaceId);
  const { data, error } = await db.rpc("reserve_comms_credit_pool", {
    p_manager_context: input.managerUserId,
    p_workspace: input.workspaceId,
    p_funders: funders.map((f) => ({ funder: f.funderUserId, tier: f.tier })),
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
    return { allowed: false, reason: String(data.reason ?? "usage_already_processed") };
  return {
    allowed: true,
    duplicate: data.duplicate === true,
    state: data.state,
    funderUserId: data.funder ? String(data.funder) : null,
  };
}

export async function finishCommsCreditPool(
  db: SupabaseClient,
  managerUserId: string,
  key: string,
  release = false,
) {
  const { data, error } = await db.rpc("finish_comms_credit_pool", {
    p_manager_context: managerUserId,
    p_key: key,
    p_release: release,
  });
  if (error || data !== true) throw new Error("Communication credit reconciliation failed.");
}

export async function settleCommsCreditQuantityPool(
  db: SupabaseClient,
  managerUserId: string,
  key: string,
  quantity: number,
) {
  const { error } = await db.rpc("settle_comms_credit_quantity_pool", {
    p_manager_context: managerUserId,
    p_key: key,
    p_quantity: quantity,
  });
  if (error) throw new Error("Communication credit settlement failed.");
}

export type CommsPoolSnapshot = {
  tier: CommsPlanTier;
  allowanceCents: number;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  remainingCents: number;
  sharedAcrossWorkspaces: boolean;
  rollsOver: boolean;
  periodStart: string;
  periodEnd: string;
  paused: boolean;
};

async function poolBudgetTier(funderUserId: string): Promise<CommsPlanTier> {
  const result = await getEffectiveManagerSkuTier(funderUserId);
  if (!result.ok) throw new Error("We could not verify your communication plan. Try again.");
  return normalizeCommsPlanTier(result.tier);
}

/** Read-only snapshot of one funder's own account pool (never applies a period). */
export async function loadCommsPoolSnapshot(
  db: SupabaseClient,
  funderUserId: string,
): Promise<CommsPoolSnapshot> {
  const tier = await poolBudgetTier(funderUserId);
  const { data, error } = await db.rpc("comms_pool_snapshot", {
    p_funder: funderUserId,
    p_tier: tier,
    p_apply: false,
  });
  if (error || !data) throw new Error("We could not load your messaging credit. Try again.");
  const cents = (key: string) => {
    const n = (data as Record<string, unknown>)[key];
    if (!Number.isSafeInteger(n) || (n as number) < 0)
      throw new Error("Messaging credit could not be verified.");
    return n as number;
  };
  const included = cents("included_remaining_cents");
  const purchased = cents("purchased_remaining_cents");
  return {
    tier,
    allowanceCents: cents("allowance_cents"),
    includedRemainingCents: included,
    purchasedRemainingCents: purchased,
    remainingCents: included + purchased,
    sharedAcrossWorkspaces: (data as Record<string, unknown>).shared_across_workspaces === true,
    rollsOver: (data as Record<string, unknown>).rolls_over === true,
    periodStart: String((data as Record<string, unknown>).period_start),
    periodEnd: String((data as Record<string, unknown>).period_end),
    paused: (data as Record<string, unknown>).paused === true,
  };
}

export type FunderWorkspaceRow = {
  workspaceId: string;
  name: string;
  owned: boolean;
  ownerName?: string;
  enabled: boolean;
  monthlyLimitCents: number | null;
  usedThisMonthCents: number;
};

/**
 * Every workspace this funder can even see (owned + accepted co-manager
 * invites — re-derived server-side, never trusted from the client), each
 * annotated with whether their pool currently funds it, its optional monthly
 * cap, and what has actually been spent there this period.
 */
export async function loadFunderWorkspaceRows(
  db: SupabaseClient,
  funderUserId: string,
): Promise<FunderWorkspaceRow[]> {
  const workspaces = await loadWorkspaces(db, funderUserId);
  if (workspaces.length === 0) return [];
  const ids = workspaces.map((w) => w.id);
  const [{ data: funding }, { data: pool }] = await Promise.all([
    db
      .from("comms_workspace_funding")
      .select("workspace_id, enabled, monthly_limit_cents")
      .eq("funder_user_id", funderUserId)
      .in("workspace_id", ids),
    db.from("comms_account_pools").select("credit_period_start").eq("funder_user_id", funderUserId).maybeSingle(),
  ]);
  const periodStart = pool?.credit_period_start ?? null;
  const spendMap = new Map<string, number>();
  if (periodStart) {
    const { data: spend } = await db
      .from("comms_funder_workspace_spend")
      .select("workspace_id, spent_cents")
      .eq("funder_user_id", funderUserId)
      .eq("period_start", periodStart)
      .in("workspace_id", ids);
    for (const row of spend ?? []) spendMap.set(String(row.workspace_id), Number(row.spent_cents ?? 0));
  }
  const fundingMap = new Map(
    (funding ?? []).map((r) => [String(r.workspace_id), r as { enabled: boolean; monthly_limit_cents: number | null }]),
  );
  return workspaces.map((w) => {
    const row = fundingMap.get(w.id);
    return {
      workspaceId: w.id,
      name: w.name,
      owned: w.owned,
      ownerName: w.owned ? undefined : w.ownerName,
      enabled: row?.enabled === true,
      monthlyLimitCents: row?.monthly_limit_cents ?? null,
      usedThisMonthCents: spendMap.get(w.id) ?? 0,
    };
  });
}

/**
 * "Your credit funds: All my workspaces / <workspace> only" — rewrites the
 * funder's whole funding scope to exactly the workspaces they can currently
 * access (never a client-supplied list). `{kind:"one"}` enables only the
 * named workspace and disables every other; `{kind:"all"}` enables every
 * accessible workspace.
 */
export async function setFunderFundingScope(
  db: SupabaseClient,
  funderUserId: string,
  scope: { kind: "all" } | { kind: "one"; workspaceId: string },
): Promise<void> {
  const workspaces = await loadWorkspaces(db, funderUserId);
  const eligibleIds = workspaces.map((w) => w.id);
  if (scope.kind === "one" && !eligibleIds.includes(scope.workspaceId)) {
    throw new Error("Choose a workspace you have access to.");
  }
  if (eligibleIds.length === 0) return;
  const rows = eligibleIds.map((workspaceId) => ({
    funder_user_id: funderUserId,
    workspace_id: workspaceId,
    enabled: scope.kind === "all" ? true : workspaceId === scope.workspaceId,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await db
    .from("comms_workspace_funding")
    .upsert(rows, { onConflict: "funder_user_id,workspace_id" });
  if (error) throw new Error("Could not update which workspaces your credit funds.");
}

/** A monthly cap only ever narrows an ALREADY-funded workspace; it never
 * turns funding on for one this funder has not enabled. */
export async function setFunderWorkspaceMonthlyLimit(
  db: SupabaseClient,
  funderUserId: string,
  workspaceId: string,
  monthlyLimitCents: number | null,
): Promise<void> {
  const workspaces = await loadWorkspaces(db, funderUserId);
  if (!workspaces.some((w) => w.id === workspaceId)) throw new Error("Choose a workspace you have access to.");
  const { error, count } = await db
    .from("comms_workspace_funding")
    .update({ monthly_limit_cents: monthlyLimitCents, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("funder_user_id", funderUserId)
    .eq("workspace_id", workspaceId)
    .eq("enabled", true);
  if (error) throw new Error("Could not save the monthly limit.");
  if (!count) throw new Error("Turn on funding for this workspace before setting a limit.");
}

/** @deprecated kept only for the illustrative pool-purpose Stripe metadata constant. */
export const COMMS_CREDIT_POOL_PURPOSE = "manager_communication_credit_pool";

/**
 * `applies_to_workspace_id` null means "all my workspaces" (the default);
 * a value pins the purchase's later funding-scope effect to that one
 * workspace. The scope itself is not written until fulfillment — a purchase
 * that never completes must never change what a funder's pool already funds.
 */
export async function createCommsCreditPoolCheckout(
  db: SupabaseClient,
  funderUserId: string,
  purchaseId: string,
  creditCents: number,
  appliesToWorkspaceId: string | null,
  req: Request,
) {
  await assertTestWorkspaceProviderEffectAllowed({
    userId: funderUserId,
    kind: "payment",
    summary: "Messaging credit checkout refused for a test workspace.",
    db,
  });
  if (!isValidCommsCreditAmountCents(creditCents))
    throw new Error("Enter a whole-dollar amount from $5 to $500.");
  if (appliesToWorkspaceId) {
    const workspaces = await loadWorkspaces(db, funderUserId);
    if (!workspaces.some((w) => w.id === appliesToWorkspaceId))
      throw new Error("Choose a workspace you have access to.");
  }
  const { error: insertError } = await db.from("comms_pool_credit_purchases").insert({
    id: purchaseId,
    funder_user_id: funderUserId,
    applies_to_workspace_id: appliesToWorkspaceId,
    credit_cents: creditCents,
  });
  if (insertError && insertError.code !== "23505")
    throw new Error("Could not start the credit purchase.");
  const { data: purchase, error } = await db
    .from("comms_pool_credit_purchases")
    .select("funder_user_id, applies_to_workspace_id, credit_cents, stripe_session_id, status, created_at")
    .eq("id", purchaseId)
    .eq("funder_user_id", funderUserId)
    .single();
  if (error || !purchase || purchase.credit_cents !== creditCents)
    throw new Error("Credit purchase does not match this account.");
  if ((purchase.applies_to_workspace_id ?? null) !== (appliesToWorkspaceId ?? null))
    throw new Error("Credit purchase does not match this workspace choice.");
  if (purchase.status !== "pending")
    throw new Error("This purchase has already been processed. Refresh your balance.");
  if (Date.now() - Date.parse(purchase.created_at) > 23 * 60 * 60 * 1000) {
    throw new Error("This checkout attempt expired. Close it and start a new purchase.");
  }
  const stripe = getStripe();
  if (purchase.stripe_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(purchase.stripe_session_id);
    if (existing.status !== "open" || !existing.client_secret)
      throw new Error("This checkout is no longer open. Refresh your balance.");
    return { clientSecret: existing.client_secret, purchaseId };
  }
  const customer = await ensureManagerBillingCustomer(db, funderUserId);
  const metadata = {
    purpose: COMMS_CREDIT_POOL_PURPOSE,
    manager_user_id: funderUserId,
    purchase_id: purchaseId,
    credit_cents: String(creditCents),
    applies_to_workspace_id: appliesToWorkspaceId ?? "",
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer,
      saved_payment_method_options: { payment_method_save: "enabled" },
      ui_mode: "embedded_page",
      payment_method_types: ["card"],
      client_reference_id: funderUserId,
      metadata,
      payment_intent_data: { metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: creditCents,
            product_data: {
              name: "PropLane messaging credit",
              description: "One-time credit for texts, calls and work-number AI. No automatic recharge.",
            },
          },
        },
      ],
      return_url: `${resolveAppOrigin(req)}/portal/profile?tab=billing&comms_pool_purchase=${purchaseId}`,
    },
    { idempotencyKey: `comms-credit-pool:${funderUserId}:${purchaseId}` },
  );
  if (!session.client_secret) throw new Error("Checkout could not be opened.");
  const { error: saveError } = await db
    .from("comms_pool_credit_purchases")
    .update({ stripe_session_id: session.id })
    .eq("id", purchaseId)
    .eq("funder_user_id", funderUserId);
  if (saveError) throw new Error("Checkout could not be saved. Retry this purchase.");
  return { clientSecret: session.client_secret, purchaseId };
}

/** Signed webhook only. Returns false when this session is not a pool purchase. */
export async function fulfillCommsCreditPoolPurchase(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
  eventId: string,
) {
  if (session.metadata?.purpose !== COMMS_CREDIT_POOL_PURPOSE) return false;
  if (session.payment_status !== "paid") return false;
  const funder = session.metadata.manager_user_id;
  const purchase = session.metadata.purchase_id;
  const credit = Number(session.metadata.credit_cents);
  const paymentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (
    !funder ||
    !purchase ||
    !paymentId ||
    session.mode !== "payment" ||
    session.currency !== "usd" ||
    !isValidCommsCreditAmountCents(credit) ||
    session.amount_subtotal !== credit ||
    session.amount_total !== credit ||
    session.client_reference_id !== funder ||
    (session.total_details?.amount_discount ?? 0) !== 0
  ) {
    throw new CommsCreditValidationError("Communication payment did not match the purchase.");
  }
  const { data: stored, error: storedError } = await db
    .from("comms_pool_credit_purchases")
    .select("funder_user_id, applies_to_workspace_id")
    .eq("id", purchase)
    .maybeSingle();
  if (storedError) {
    // Staging/prod run with the pool flag off and the migration not applied
    // at all — the table simply is not there. A purchase carrying this
    // purpose could only exist if the pool schema already created it, so an
    // undefined-table/column error here means "not a real pool purchase",
    // never a reason to fail the whole webhook request.
    if (isMissingPoolSchemaError(storedError)) return false;
    throw new Error("Communication credit ownership could not be verified.");
  }
  const storedFunder = String((stored as { funder_user_id?: string | null } | null)?.funder_user_id ?? "").trim();
  if (!storedFunder || storedFunder !== funder) {
    throw new CommsCreditValidationError("Communication payment did not match a purchase on this account.");
  }
  if (
    (
      await captureTestWorkspaceEffectForUser({
        userId: storedFunder,
        kind: "payment",
        summary: "Messaging credit fulfillment was refused for a test workspace.",
        metadata: { operation: "credit_pool_fulfillment" },
        db,
      })
    ).captured
  )
    return false;
  const { data, error } = await db.rpc("fulfill_comms_pool_credit_purchase", {
    p_purchase: purchase,
    p_funder: funder,
    p_session: session.id,
    p_payment_intent: paymentId,
    p_credit: credit,
    p_event: eventId,
    p_receipt: null,
  });
  if (error) {
    if (isTerminalFulfillmentError(error))
      throw new CommsCreditValidationError("Communication payment did not match a purchase on this account.");
    throw new Error("Communication credit could not be added.");
  }
  if (data === true) {
    const appliesTo = (stored as { applies_to_workspace_id?: string | null } | null)?.applies_to_workspace_id ?? null;
    await setFunderFundingScope(
      db,
      storedFunder,
      appliesTo ? { kind: "one", workspaceId: String(appliesTo) } : { kind: "all" },
    ).catch(() => undefined);
  }
  return data === true;
}

/** Mirrors `reverseCommsCreditForPaymentIntent` for pool purchases. Returns
 * false (never throws for "not found") when this payment intent is not a
 * pool purchase, so the webhook can try both purchase tables safely. */
export async function reverseCommsCreditPoolForPaymentIntent(
  db: SupabaseClient,
  paymentIntentId: string | null | undefined,
  eventId: string,
  opts: { dispute?: boolean; loadCharge: () => Promise<Stripe.Charge> },
) {
  const dispute = opts.dispute === true;
  const paymentId = (paymentIntentId ?? "").trim();
  if (!paymentId) return false;
  const { data: purchase, error: readError } = await db
    .from("comms_pool_credit_purchases")
    .select("id, credit_cents, funder_user_id")
    .eq("stripe_payment_intent_id", paymentId)
    .maybeSingle();
  if (readError) {
    // Same reasoning as `fulfillCommsCreditPoolPurchase`: this table may not
    // exist at all where the pool flag is off (staging/prod, pre-migration).
    // Every `charge.refunded` / `refund.*` / dispute event calls this
    // unconditionally alongside the legacy reversal, so it must never throw
    // for "the pool schema isn't deployed here" — only for a real failure.
    if (isMissingPoolSchemaError(readError)) return false;
    throw new Error("Credit reversal could not be verified.");
  }
  if (!purchase) return false;
  const funder = String(purchase.funder_user_id ?? "").trim();
  if (!funder) throw new Error("Credit reversal ownership could not be verified.");
  if (
    (
      await captureTestWorkspaceEffectForUser({
        userId: funder,
        kind: "payment",
        summary: "Messaging credit reversal was refused for a test workspace.",
        metadata: { operation: dispute ? "credit_pool_dispute" : "credit_pool_refund" },
        db,
      })
    ).captured
  )
    return false;
  const reversed = dispute
    ? purchase.credit_cents
    : Math.min(purchase.credit_cents, (await opts.loadCharge()).amount_refunded);
  const { data, error } = await db.rpc("reverse_comms_pool_credit_purchase", {
    p_payment_intent: paymentId,
    p_reversed: reversed,
    p_event: eventId,
    p_reason: dispute ? "dispute" : "refund",
  });
  if (error) throw new Error("Communication credit reversal failed.");
  return data === true;
}

export type CommsPlanCreditRule = {
  tier: CommsPlanTier;
  includedCents: number;
  sharedAcrossWorkspaces: boolean;
  rollsOver: boolean;
  updatedAt: string;
};

/**
 * Admin-only. The 3 per-tier rows `comms_plan_credit_rules` seeds. The admin
 * Billing page mounts this unconditionally, but staging/production run with
 * the pool migration not applied at all — an undefined-table/column error
 * there means "not deployed here yet", so this returns an empty list rather
 * than surfacing an error banner on every visit to that page.
 */
export async function loadCommsPlanCreditRules(db: SupabaseClient): Promise<CommsPlanCreditRule[]> {
  const { data, error } = await db
    .from("comms_plan_credit_rules")
    .select("tier, included_cents, shared_across_workspaces, rolls_over, updated_at")
    .order("tier");
  if (error) {
    if (isMissingPoolSchemaError(error)) return [];
    throw new Error("Could not load plan credit rules.");
  }
  return (data ?? []).map((row) => ({
    tier: normalizeCommsPlanTier(row.tier),
    includedCents: Number(row.included_cents ?? 0),
    sharedAcrossWorkspaces: row.shared_across_workspaces === true,
    rollsOver: row.rolls_over === true,
    updatedAt: String(row.updated_at),
  }));
}

/** Admin-only write. Caller has already verified admin authorization. */
export async function saveCommsPlanCreditRule(
  db: SupabaseClient,
  tier: CommsPlanTier,
  input: { includedCents: number; sharedAcrossWorkspaces: boolean; rollsOver: boolean },
): Promise<void> {
  if (!Number.isSafeInteger(input.includedCents) || input.includedCents < 0 || input.includedCents > 1_000_000) {
    throw new Error("Enter a whole-dollar included amount.");
  }
  const { error } = await db
    .from("comms_plan_credit_rules")
    .update({
      included_cents: input.includedCents,
      shared_across_workspaces: input.sharedAcrossWorkspaces,
      rolls_over: input.rollsOver,
      updated_at: new Date().toISOString(),
    })
    .eq("tier", tier);
  if (error) throw new Error("Could not save the plan credit rule.");
}
