import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PropLane staff's per-account billing overrides.
 *
 * These sit BESIDE the plan rather than inside it. `resolveEffectiveManagerSkuTier` stays the only
 * answer to "what plan is this account on" — nothing here rewrites `manager_purchases` — so the
 * displayed plan and the enforced plan cannot drift apart. What an override does is bend ONE
 * consequence of that plan for one account, with a staff actor and a reason recorded in
 * `audit_log`.
 *
 * Only `propertyCap` is READ by enforcement today (`assertManagerPropertyListingQuota`).
 * `trialEndsAt` and `complimentary` are RECORDED AND DISPLAYED ONLY: no billing, quota or plan
 * resolver consults them yet. That is deliberate for now — a comp flag that silently stopped
 * invoicing would be a money change made in a UI ticket — and it is stated in the admin screen
 * itself so staff are never told a switch does more than it does.
 *
 * Storage is `manager_automation_settings.row_data.billingOverrides`, alongside `manualPayments`,
 * `tourSettings` and the rest of that per-manager settings blob. No new table and no new column:
 * `row_data` exists in every deployment of that table, so this needed no migration.
 *
 * It is NOT manager-writable. Nothing on the manager's own settings routes reads or writes this
 * key — every one of them read-modify-writes its own key inside `row_data` — and the only writer
 * is {@link saveManagerBillingOverrides}, called from the staff-authorized admin route. Like every
 * other service-role writer here, this module does no authorization of its own; the route is the
 * boundary.
 */

/** The key inside `manager_automation_settings.row_data`. */
export const MANAGER_BILLING_OVERRIDES_KEY = "billingOverrides";

/** Highest cap staff may pin. High enough for any real portfolio, low enough to catch a typo. */
export const MANAGER_PROPERTY_CAP_OVERRIDE_MAX = 1000;

export type ManagerBillingOverrides = {
  /**
   * Listing slots this account may hold, replacing the plan's cap. `null` = follow the plan.
   *
   * `0` is a real, distinct value: it means "may not put anything new into a listing slot", which
   * is why this is `null`-for-absent rather than falsy-for-absent.
   */
  propertyCap: number | null;
  /** `YYYY-MM-DD`, recorded for support. Not read by the plan resolver — see the file comment. */
  trialEndsAt: string | null;
  /** "Complimentary — do not bill". Recorded and displayed only; billing does not read it yet. */
  complimentary: boolean;
};

export const EMPTY_MANAGER_BILLING_OVERRIDES: ManagerBillingOverrides = {
  propertyCap: null,
  trialEndsAt: null,
  complimentary: false,
};

/** The fields a staff write may name. Each one is audited under its own key. */
export const MANAGER_BILLING_OVERRIDE_FIELDS = ["propertyCap", "trialEndsAt", "complimentary"] as const;
export type ManagerBillingOverrideField = (typeof MANAGER_BILLING_OVERRIDE_FIELDS)[number];

function normalizeCap(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 0 || n > MANAGER_PROPERTY_CAP_OVERRIDE_MAX) return null;
  return n;
}

function normalizeTrialEnd(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  // Round-trip so 2026-02-31 is rejected rather than silently rolling into March.
  return new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

export function normalizeManagerBillingOverrides(raw: unknown): ManagerBillingOverrides {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    propertyCap: normalizeCap(row.propertyCap),
    trialEndsAt: normalizeTrialEnd(row.trialEndsAt),
    complimentary: row.complimentary === true,
  };
}

/** True when nothing is set — used to omit the key entirely rather than store an empty object. */
export function managerBillingOverridesAreEmpty(overrides: ManagerBillingOverrides): boolean {
  return overrides.propertyCap === null && overrides.trialEndsAt === null && !overrides.complimentary;
}

export type OverrideParse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse a property-cap override from a request body.
 *
 * `null` (or an empty string) CLEARS it and returns the account to its plan cap. That is a
 * different act from pinning the plan's own number, which would freeze the cap through a later
 * upgrade — so the two must not collapse into one, exactly as the fee-payer override already
 * distinguishes "clear" from "pin resident".
 *
 * Anything else is REFUSED rather than coerced: a cap silently rounded from "3.5", or read as 0
 * because it was "abc", reports success while doing something other than what was asked — and
 * this number decides whether a paying manager can publish.
 */
export function parsePropertyCapOverride(raw: unknown): OverrideParse<number | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "propertyCap must be a whole number, or null to follow the plan." };
  }
  if (n < 0 || n > MANAGER_PROPERTY_CAP_OVERRIDE_MAX) {
    return { ok: false, error: `propertyCap must be between 0 and ${MANAGER_PROPERTY_CAP_OVERRIDE_MAX}.` };
  }
  return { ok: true, value: n };
}

export function parseTrialEndOverride(raw: unknown): OverrideParse<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: null };
  const value = normalizeTrialEnd(raw);
  if (!value) return { ok: false, error: "trialEndsAt must be a calendar date (YYYY-MM-DD), or null to clear it." };
  return { ok: true, value };
}

export function parseComplimentaryOverride(raw: unknown): OverrideParse<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  return { ok: false, error: "complimentary must be true or false." };
}

/**
 * The cap this account is actually held to, and where it came from.
 *
 * The source matters to the caller because the refusal message differs: a plan cap names the plan
 * and what lifts it, while a staff-pinned cap must not tell the manager to upgrade — upgrading
 * would not move it.
 */
export function resolveManagerPropertyCap(input: {
  planLimit: number | null;
  capOverride: number | null;
}): { limit: number | null; source: "override" | "plan" } {
  if (input.capOverride !== null) return { limit: input.capOverride, source: "override" };
  return { limit: input.planLimit, source: "plan" };
}

/** Refusal copy for a staff-pinned cap. Never an upgrade CTA — an upgrade would not lift it. */
export function managerPropertyCapOverrideMessage(limit: number): string {
  if (limit === 0) return "This account is not currently allowed to publish listings. Contact PropLane support.";
  return `This account is set to a limit of ${limit} ${limit === 1 ? "property" : "properties"}. Contact PropLane support to change it.`;
}

export type ManagerBillingOverridesRead =
  | { ok: true; overrides: ManagerBillingOverrides }
  | { ok: false; error: string };

/**
 * Read one manager's overrides.
 *
 * Returns a RESULT rather than defaulting on error, for the same reason
 * `getEffectiveManagerSkuTier` does: an unread override and an absent one both come back as no
 * data, and they mean opposite things to the property cap. Silently reading "could not tell" as
 * "no override" would enforce the Free cap on an account staff had explicitly comped a bigger one.
 */
export async function loadManagerBillingOverrides(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerBillingOverridesRead> {
  try {
    const { data, error } = await db
      .from("manager_automation_settings")
      .select("row_data")
      .eq("manager_user_id", managerUserId)
      .maybeSingle();
    if (error) return { ok: false, error: "Could not read this account's billing overrides." };
    const rowData = (data?.row_data ?? null) as Record<string, unknown> | null;
    return { ok: true, overrides: normalizeManagerBillingOverrides(rowData?.[MANAGER_BILLING_OVERRIDES_KEY]) };
  } catch {
    return { ok: false, error: "Could not read this account's billing overrides." };
  }
}

/** Same read, for many managers at once — the admin Billing list, which must not fan out per row. */
export async function loadManagerBillingOverridesForIds(
  db: SupabaseClient,
  managerUserIds: string[],
): Promise<Map<string, ManagerBillingOverrides>> {
  const byId = new Map<string, ManagerBillingOverrides>();
  if (managerUserIds.length === 0) return byId;
  const { data } = await db
    .from("manager_automation_settings")
    .select("manager_user_id, row_data")
    .in("manager_user_id", managerUserIds);
  for (const row of (data ?? []) as { manager_user_id: string; row_data: Record<string, unknown> | null }[]) {
    byId.set(
      String(row.manager_user_id),
      normalizeManagerBillingOverrides(row.row_data?.[MANAGER_BILLING_OVERRIDES_KEY]),
    );
  }
  return byId;
}

/**
 * Write one manager's overrides.
 *
 * Read-modify-write of `row_data`, preserving every sibling key, because the same column carries
 * this manager's tour settings, application automation and lifecycle tasks. The caller must
 * already have authorized the actor as staff; this does no authorization of its own.
 */
export async function saveManagerBillingOverrides(
  db: SupabaseClient,
  managerUserId: string,
  next: ManagerBillingOverrides,
): Promise<ManagerBillingOverrides> {
  const { data: existing, error: readError } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  // Refuse rather than write over a blob we could not read: the sibling keys in `row_data` are
  // another manager-owned setting each, and overwriting them is not recoverable from here.
  if (readError) throw new Error("Could not read stored settings; refusing to write billing overrides.");

  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const normalized = normalizeManagerBillingOverrides(next);
  // An account with nothing pinned stores no key at all, so an untouched manager's settings stay
  // byte-identical to what they were before this field existed.
  if (managerBillingOverridesAreEmpty(normalized)) delete rowData[MANAGER_BILLING_OVERRIDES_KEY];
  else rowData[MANAGER_BILLING_OVERRIDES_KEY] = normalized;

  const { error } = await db.from("manager_automation_settings").upsert(
    { manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() },
    { onConflict: "manager_user_id" },
  );
  if (error) throw new Error(error.message);
  return normalized;
}
