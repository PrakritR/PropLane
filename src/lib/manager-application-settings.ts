import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Manager-global application settings — currently just the application fee the
 * manager charges applicants, set ONCE for the whole account instead of per
 * listing (captain decision, 2026-07: "manager sets cost of application in
 * application rather than in the property listing").
 *
 * Source-of-truth model (see `docs/agents/resident-payments.md`):
 * - `applicationFeeCents` is the authoritative fee for EVERY one of the
 *   manager's listings once the manager has saved it (non-null).
 * - Until the manager saves a value it is `null`, and the fee resolver falls
 *   back to each listing's stored `applicationFee` (grandfathered) so nothing a
 *   live listing already charges changes silently on deploy.
 * - New listings no longer carry their own fee field, so they always resolve to
 *   this manager-level value (or the $50 legacy default when still unset).
 *
 * `0` is a MEANINGFUL saved value ("applications are free for my properties"),
 * distinct from `null` ("not configured — use the listing/legacy fallback").
 *
 * Stored on `manager_automation_settings.row_data.applicationSettings` — the
 * `row_data` JSON column that table always has — so this needs NO schema
 * migration and cannot break on a production project whose columns lag dev.
 */
/** When to collect the manager-level application fee from repeat applicants. */
export type ApplicationFeeChargePolicy = "first_only" | "every_time";

export type ManagerApplicationSettings = {
  /** Whole-account application fee in cents. `null` = not configured. */
  applicationFeeCents: number | null;
  /**
   * `first_only` — waive the fee when the resident already submitted to or paid
   * this manager (default). `every_time` — charge on every new application.
   */
  applicationFeeChargePolicy: ApplicationFeeChargePolicy;
  /** Optional custom payment instructions (Zelle/Venmo/cash, etc.). */
  applicationFeeOtherEnabled: boolean;
  applicationFeeOtherInstructions: string;
};

export const DEFAULT_MANAGER_APPLICATION_SETTINGS: ManagerApplicationSettings = {
  applicationFeeCents: null,
  applicationFeeChargePolicy: "first_only",
  applicationFeeOtherEnabled: false,
  applicationFeeOtherInstructions: "",
};

/** Legacy per-listing fallback used when no manager-level value and no listing value exists. */
export const LEGACY_DEFAULT_APPLICATION_FEE_CENTS = 5000;

export const MANAGER_APPLICATION_SETTINGS_EVENT = "axis:manager-application-settings";

/**
 * Stripe's checkout minimum is $1, and the fee resolver floors any sub-$1
 * amount to 0 — so a saved fee of 1–99 cents would show as configured in the
 * settings modal while every applicant passes through free. Writes reject
 * such values outright (`validateManagerApplicationFeeCents`); `0` stays the
 * one explicit "applications are free" value.
 */
export const MIN_MANAGER_APPLICATION_FEE_CENTS = 100;
/** Cap at $1,000 so a fat-fingered value can never propose an absurd charge. */
export const MAX_MANAGER_APPLICATION_FEE_CENTS = 100_000;

const ROW_DATA_KEY = "applicationSettings";

function normalizeApplicationFeeChargePolicy(raw: unknown): ApplicationFeeChargePolicy {
  return raw === "every_time" ? "every_time" : "first_only";
}

export function normalizeManagerApplicationSettings(raw: unknown): ManagerApplicationSettings {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const rawFee = row.applicationFeeCents;
  let applicationFeeCents: number | null = null;
  if (typeof rawFee === "number" && Number.isFinite(rawFee)) {
    const cents = Math.round(rawFee);
    if (cents === 0) {
      applicationFeeCents = 0;
    } else if (cents >= MIN_MANAGER_APPLICATION_FEE_CENTS) {
      applicationFeeCents =
        cents > MAX_MANAGER_APPLICATION_FEE_CENTS ? MAX_MANAGER_APPLICATION_FEE_CENTS : cents;
    }
  }
  const instructions =
    typeof row.applicationFeeOtherInstructions === "string" ? row.applicationFeeOtherInstructions.trim() : "";
  const applicationFeeOtherEnabled =
    row.applicationFeeOtherEnabled === true && instructions.length > 0;
  return {
    applicationFeeCents,
    applicationFeeChargePolicy: normalizeApplicationFeeChargePolicy(row.applicationFeeChargePolicy),
    applicationFeeOtherEnabled,
    applicationFeeOtherInstructions: instructions,
  };
}

export type ManagerApplicationFeeValidation =
  | { ok: true; applicationFeeCents: number | null }
  | { ok: false; error: string };

/**
 * Write-path validation for the manager-level application fee. Unlike
 * `normalizeManagerApplicationSettings` (which tolerantly reads whatever is
 * stored), this REJECTS un-savable input with a user-facing message instead of
 * coercing it: a negative fee, a non-zero fee under $1 (un-chargeable — see
 * `MIN_MANAGER_APPLICATION_FEE_CENTS`), an over-cap fee, or a non-numeric
 * value. `null`/absent clears the setting; `0` makes applications free.
 */
export function validateManagerApplicationFeeCents(raw: unknown): ManagerApplicationFeeValidation {
  if (raw == null) return { ok: true, applicationFeeCents: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: "Enter a valid application fee." };
  }
  const cents = Math.round(raw);
  if (cents < 0) {
    return { ok: false, error: "The application fee cannot be negative." };
  }
  if (cents === 0) return { ok: true, applicationFeeCents: 0 };
  if (cents < MIN_MANAGER_APPLICATION_FEE_CENTS) {
    return { ok: false, error: "The application fee must be at least $1 — or $0 to make applications free." };
  }
  if (cents > MAX_MANAGER_APPLICATION_FEE_CENTS) {
    return { ok: false, error: "The application fee cannot exceed $1,000." };
  }
  return { ok: true, applicationFeeCents: cents };
}

/**
 * The effective application fee (cents) for one listing, applying the
 * source-of-truth priority: a configured manager-level value wins for every
 * listing; otherwise the listing's own grandfathered value; otherwise the
 * legacy $50 default. Pure — safe to use on client and server.
 */
export function effectiveApplicationFeeCents(input: {
  managerFeeCents: number | null;
  /**
   * The listing's OWN application fee in cents, or `null` when the listing sets no value.
   *
   * Per-listing is AUTHORITATIVE (captain decision, [app-fee-authority] option B): a value
   * here — INCLUDING 0, which means "free" — wins and is charged. The account-wide
   * `managerFeeCents` is only a DEFAULT for listings that set nothing; it never overrides a
   * listing's own value. Passing 0 vs `null` is load-bearing: a deliberate per-listing $0
   * must never fall through to a non-zero account-wide value.
   */
  listingFeeCents: number | null;
}): number {
  if (input.listingFeeCents !== null) return input.listingFeeCents;
  if (input.managerFeeCents !== null) return input.managerFeeCents;
  return LEGACY_DEFAULT_APPLICATION_FEE_CENTS;
}

export async function loadManagerApplicationSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerApplicationSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeManagerApplicationSettings(
    (data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY],
  );
}

export async function saveManagerApplicationSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: ManagerApplicationSettings,
): Promise<ManagerApplicationSettings> {
  const normalized = normalizeManagerApplicationSettings(settings);
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = normalized;
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
