/**
 * Server resolver for the per-manager number ACCESS decision (pure rules in
 * number-registration-policy.ts): a work number is a paid Pro/Business
 * feature behind a deliberate enablement allowlist.
 *
 * Two enforcement points read this:
 *   • `provisionManagerNumber` — buying. Fails CLOSED on every disallow
 *     (including an unreadable plan): it is the money path, and parking is
 *     retryable (signup hook, daily sweep, on-demand tab load all re-check).
 *   • The send paths — service. A manager who downgrades to Free keeps their
 *     number (people wrote it down; it is NEVER auto-released) but the number
 *     stops sending: same decision, read at send time, no billing hooks
 *     needed. The send paths use {@link sendAllowedByAccess}, which lets
 *     `plan_unreadable` through — an infra blip must not drop all messaging.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  managerNumberAccessDecision,
  smsProvisioningAllowlist,
  type ManagerNumberAccessDecision,
} from "@/lib/sms/number-registration-policy";

export type { ManagerNumberAccessDecision };

/** Placeholder plan for decision modes that never read billing (list mode). */
const UNREAD_PLAN = {
  tier: null,
  billing: null,
  paidAt: null,
  stripeSubscriptionId: null,
  readFailed: true,
} as const;

export async function resolveManagerNumberAccess(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerNumberAccessDecision> {
  const id = managerUserId.trim();
  if (!id) return { allowed: false, via: null, reason: "not_enabled" };
  const allowlist = smsProvisioningAllowlist();
  // Closed allowlist (the default) decides without any reads.
  if (allowlist.mode === "closed") {
    return { allowed: false, via: null, reason: "not_enabled" };
  }
  if (allowlist.mode === "list") {
    // Deliberate per-account enablement — billing is not consulted.
    const { data: profile } = await db.from("profiles").select("email").eq("id", id).maybeSingle();
    return managerNumberAccessDecision({
      plan: UNREAD_PLAN,
      email: (profile?.email as string | null) ?? null,
      userId: id,
    });
  }
  // all_paid mode: the billing state IS the decision.
  let plan: typeof UNREAD_PLAN | {
    tier: string | null;
    billing: string | null;
    paidAt: string | null;
    stripeSubscriptionId: string | null;
    readFailed: boolean;
  } = UNREAD_PLAN;
  try {
    const sku = await getManagerPurchaseSku(id);
    plan = {
      tier: sku.tier,
      billing: sku.billing,
      paidAt: sku.paidAt,
      stripeSubscriptionId: sku.stripeSubscriptionId,
      readFailed: sku.readFailed,
    };
  } catch {
    // plan stays unread — purchase path fails closed, send path fails open.
  }
  return managerNumberAccessDecision({ plan, email: null, userId: id });
}

/**
 * Send-path reading of the decision: a definitive "not entitled" suspends the
 * number's service, but an UNREADABLE plan is an infra state, not a downgrade
 * — messaging keeps flowing (mirrors the consent gate's fail-open posture).
 */
export function sendAllowedByAccess(decision: ManagerNumberAccessDecision): boolean {
  return decision.allowed || decision.reason === "plan_unreadable";
}

/** Common storage formats for one US number, for `sms_from_number` matching. */
function workNumberVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return [raw.trim()].filter(Boolean);
  return [
    `+1${national}`,
    national,
    `1${national}`,
    `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
    `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`,
    raw.trim(),
  ].filter(Boolean);
}

export type WorkNumberOwnerAccess = {
  managerUserId: string;
  decision: ManagerNumberAccessDecision;
};

/**
 * The owner+access lookup runs on EVERY outbound send, so a bulk fan-out (rent
 * reminders, relay broadcast) would otherwise pay two reads per recipient for
 * an answer that is identical across the whole run. Memoized per from-number
 * for a minute — long enough to collapse a fan-out, short enough that a
 * suspension or an enablement bites almost immediately. Per-instance only, like
 * the Google-busy cache; it is a cost bound, never an authority.
 */
const OWNER_ACCESS_TTL_MS = 60_000;
const OWNER_ACCESS_CACHE_MAX = 500;
const ownerAccessCache = new Map<
  string,
  { expiresAtMs: number; value: WorkNumberOwnerAccess | null }
>();

function readOwnerAccessCache(
  key: string,
): { value: WorkNumberOwnerAccess | null } | null {
  const hit = ownerAccessCache.get(key);
  if (!hit) return null;
  if (hit.expiresAtMs <= Date.now()) {
    ownerAccessCache.delete(key);
    return null;
  }
  return { value: hit.value };
}

function writeOwnerAccessCache(key: string, value: WorkNumberOwnerAccess | null): void {
  if (ownerAccessCache.size >= OWNER_ACCESS_CACHE_MAX) ownerAccessCache.clear();
  ownerAccessCache.set(key, { expiresAtMs: Date.now() + OWNER_ACCESS_TTL_MS, value });
}

/** Test seam — drops the memo so a state change is observable immediately. */
export function clearWorkNumberOwnerAccessCache(): void {
  ownerAccessCache.clear();
}

/**
 * When `fromNumber` is a manager's own work number, that manager's id + access
 * decision; null when the number is unowned (shared agent line, relay pool,
 * TWILIO_DEFAULT_FROM). The shared Claw line is stamped on MANY profiles, so a
 * match that is the shared line is treated as unowned rather than gating on an
 * arbitrary manager's plan.
 */
export async function resolveWorkNumberOwnerAccess(
  db: SupabaseClient,
  fromNumber: string,
): Promise<WorkNumberOwnerAccess | null> {
  const from = String(fromNumber ?? "").trim();
  if (!from) return null;
  const { isLegacyClawSharedSmsNumber } = await import("@/lib/claw-leasing-links");
  if (isLegacyClawSharedSmsNumber(from)) return null;
  const cacheKey = workNumberVariants(from)[0] ?? from;
  const cached = readOwnerAccessCache(cacheKey);
  if (cached) return cached.value;
  const { data } = await db
    .from("profiles")
    .select("id")
    .in("sms_from_number", workNumberVariants(from))
    .limit(2);
  const rows = (data ?? []) as Array<{ id: string }>;
  // >1 owner means a shared/mis-stamped number — not a per-manager number.
  if (rows.length !== 1) {
    writeOwnerAccessCache(cacheKey, null);
    return null;
  }
  const managerUserId = String(rows[0]?.id ?? "").trim();
  if (!managerUserId) {
    writeOwnerAccessCache(cacheKey, null);
    return null;
  }
  const decision = await resolveManagerNumberAccess(db, managerUserId);
  const resolved: WorkNumberOwnerAccess = { managerUserId, decision };
  writeOwnerAccessCache(cacheKey, resolved);
  return resolved;
}
