import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingColumnError } from "@/lib/db-missing-column";
import { loadAccountPurchaseRows, loadPurchaseRowsByEmail } from "@/lib/manager-purchase-account-rows.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isWaiverGrantEnded,
  PROMO_CODE_EXPIRED_MESSAGE,
  PROMO_CODE_UNREADABLE_MESSAGE,
  promoInstantHasPassed,
  promoPolicyKey,
} from "@/lib/promo-code-expiry";

/**
 * Reads `manager_promo_code_policies` (service role only; RLS on, no client policies) and answers the
 * two questions expiring waiver codes raise:
 *
 *  - {@link checkPromoCodeRedeemable}: may a NEW redemption use this code? Fails CLOSED: a policy
 *    that cannot be read refuses the redemption.
 *  - {@link waiverGrantEndedFor}: has an EXISTING waiver grant ended? Fails SAFE: an unreadable
 *    policy (or `promo_ends_at` column) means "still valid", so a database blip never knocks an
 *    account that is paying-equivalent down to Free. The stored row is never rewritten.
 *
 * One policy snapshot per instance for at most 30 seconds (`createTtlCache`, which shares one
 * in-flight read and never caches a failure). Disabled under test so reads stay mockable.
 */

const POLICY_TTL_MS = 30_000;
const POLICY_TABLE = "manager_promo_code_policies";

export type PromoPolicyRead =
  | { ok: true; expiresAtByCode: ReadonlyMap<string, string | null> }
  | { ok: false };

const policyCache = createTtlCache<ReadonlyMap<string, string | null>>(POLICY_TTL_MS);

/** Missing relation or column: no policy can exist yet (code ahead of the migration). */
function isMissingSchema(error: { code?: string | null } | null | undefined): boolean {
  const code = String(error?.code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204";
}

async function loadPolicies(db: SupabaseClient): Promise<ReadonlyMap<string, string | null>> {
  const { data, error } = await db.from(POLICY_TABLE).select("code, expires_at");
  if (error) {
    // The table is created by the migration that ships with this code. Before it lands, there is no
    // policy to enforce; any other failure is a genuine read failure.
    if (isMissingSchema(error)) return new Map();
    throw new Error(`promo policy read failed: ${error.message}`);
  }
  const out = new Map<string, string | null>();
  for (const row of (data ?? []) as Array<{ code?: string | null; expires_at?: string | null }>) {
    const key = promoPolicyKey(row.code);
    if (key) out.set(key, row.expires_at ?? null);
  }
  return out;
}

/** Every code policy, keyed by normalized code. `ok: false` when the table cannot be read. */
export async function readPromoCodePolicies(db?: SupabaseClient): Promise<PromoPolicyRead> {
  try {
    const client = db ?? createSupabaseServiceRoleClient();
    const expiresAtByCode = serverSnapshotCacheEnabled()
      ? await policyCache.get("all", () => loadPolicies(client))
      : await loadPolicies(client);
    return { ok: true, expiresAtByCode };
  } catch (error) {
    console.error("promo code policy read failed", error);
    return { ok: false };
  }
}

/** Drops this instance's snapshot (after a staff write, and in tests). */
export function clearPromoCodePolicyCache(): void {
  policyCache.clear();
}

/**
 * The read failed only because `promo_ends_at` has not been added here yet (migration
 * 20261029010000). The column is what "ended" is stored in, so until it exists no account's promo
 * can have been ended and the answer is a real "no", not an unknown.
 */
function promoEndsAtColumnMissing(error: unknown): boolean {
  return isMissingColumnError(error, "promo_ends_at");
}

export type PromoRedeemCheck = { ok: true } | { ok: false; reason: "expired" | "unreadable" };

/** May a new redemption use `code`? Expired policy refuses; an unreadable policy refuses too (fail closed). */
export async function checkPromoCodeRedeemable(
  code: string,
  opts: { db?: SupabaseClient; nowMs?: number } = {},
): Promise<PromoRedeemCheck> {
  const key = promoPolicyKey(code);
  if (!key) return { ok: true };
  const policies = await readPromoCodePolicies(opts.db);
  if (!policies.ok) return { ok: false, reason: "unreadable" };
  const expiresAt = policies.expiresAtByCode.get(key) ?? null;
  return promoInstantHasPassed(expiresAt, opts.nowMs) ? { ok: false, reason: "expired" } : { ok: true };
}

/** The refusal text for a failed {@link checkPromoCodeRedeemable}. */
export function promoRedeemRefusal(
  check: Extract<PromoRedeemCheck, { ok: false }>,
): { error: string; code: "PROMO_EXPIRED" | "PROMO_UNREADABLE"; status: number } {
  return check.reason === "expired"
    ? { error: PROMO_CODE_EXPIRED_MESSAGE, code: "PROMO_EXPIRED", status: 400 }
    : { error: PROMO_CODE_UNREADABLE_MESSAGE, code: "PROMO_UNREADABLE", status: 503 };
}

/**
 * Has this waiver-ONLY grant ended? The caller has already established the row is waiver-only
 * (`isWaiverOnlyGrant`). `promoEndsAt` may be passed when the caller selected it; otherwise it is
 * read here by `rowId` (a missing column or failed read counts as "no end" - fail safe).
 */
export async function waiverGrantEndedFor(input: {
  promoCode: string | null | undefined;
  rowId?: string | null;
  promoEndsAt?: string | null;
  db?: SupabaseClient;
  nowMs?: number;
}): Promise<boolean> {
  const key = promoPolicyKey(input.promoCode);
  if (!key) return false;
  const db = input.db ?? createSupabaseServiceRoleClient();

  let promoEndsAt = input.promoEndsAt ?? null;
  if (input.promoEndsAt === undefined && input.rowId) {
    try {
      const { data, error } = await db.from("manager_purchases").select("promo_ends_at").eq("id", input.rowId).maybeSingle();
      if (!error) promoEndsAt = (data as { promo_ends_at?: string | null } | null)?.promo_ends_at ?? null;
    } catch {
      promoEndsAt = null;
    }
  }

  const policies = await readPromoCodePolicies(db);
  const policyExpiresAt = policies.ok ? policies.expiresAtByCode.get(key) ?? null : null;
  return isWaiverGrantEnded({ policyExpiresAt, promoEndsAt, nowMs: input.nowMs });
}

/**
 * Has staff ended the promo on this ACCOUNT (any of its purchase rows has a `promo_ends_at` in the
 * past)? Used to refuse a fresh redemption on an account whose promo was ended on purpose, so ending
 * a promo cannot be undone by typing the code again. By default a failed read or a missing column
 * answers false (evaluating a grant that already exists keeps its documented fail-safe). A NEW
 * redemption passes `failClosed: true`: if staff may have ended this account's promo and the read
 * cannot say, the redemption is refused rather than allowed.
 */
export async function accountPromoEnded(
  db: SupabaseClient,
  userId: string,
  nowMs: number = Date.now(),
  opts: { failClosed?: boolean } = {},
): Promise<boolean> {
  const id = userId.trim();
  const unreadable = opts.failClosed === true;
  if (!id) return unreadable;
  try {
    // The same rows "end promo" writes: by `user_id` OR the account's email, so an email-linked signup
    // waiver row that staff ended is not invisible here.
    const { rows, readFailed, error } = await loadAccountPurchaseRows<{ id: string; promo_ends_at?: string | null }>(
      db,
      id,
      "id, promo_ends_at",
    );
    if (readFailed) return promoEndsAtColumnMissing(error) ? false : unreadable;
    return rows.some((row) => promoInstantHasPassed(row.promo_ends_at, nowMs));
  } catch {
    return unreadable;
  }
}

/**
 * Has staff ended the promo on the account this EMAIL signs up as? The same question as
 * {@link accountPromoEnded} for a path that has no `user_id` yet (the pre-auth signup intent writes the
 * waiver row with the email alone), so re-typing the code on a new signup cannot undo an ended promo.
 * A NEW redemption passes `failClosed: true`: an unreadable answer refuses rather than grants.
 */
export async function accountPromoEndedForEmail(
  db: SupabaseClient,
  email: string,
  nowMs: number = Date.now(),
  opts: { failClosed?: boolean } = {},
): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const unreadable = opts.failClosed === true;
  if (!address) return unreadable;
  try {
    const { rows, readFailed, error } = await loadPurchaseRowsByEmail<{ id: string; promo_ends_at?: string | null }>(
      db,
      address,
      "id, promo_ends_at",
    );
    if (readFailed) return promoEndsAtColumnMissing(error) ? false : unreadable;
    return rows.some((row) => promoInstantHasPassed(row.promo_ends_at, nowMs));
  } catch {
    return unreadable;
  }
}
