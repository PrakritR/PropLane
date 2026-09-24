import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Manager-global application settings — the application fee the manager charges
 * applicants, set ONCE for the account / Application system (PLAN-0924-1254),
 * not on listing Pricing.
 *
 * Source-of-truth model (see `docs/agents/resident-payments.md`):
 * - `applicationFeeCents` is the authoritative fee for EVERY one of the
 *   manager's listings once the manager has saved it (non-null).
 * - Until the manager saves a value it is `null`, and the fee resolver uses the
 *   legacy $50 default. Listing `applicationFee` fields are ignored.
 * - `0` is a MEANINGFUL saved value ("applications are free"), distinct from
 *   `null` ("not configured — use the legacy default").
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
};

export const DEFAULT_MANAGER_APPLICATION_SETTINGS: ManagerApplicationSettings = {
  applicationFeeCents: null,
  applicationFeeChargePolicy: "first_only",
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
  return {
    applicationFeeCents,
    applicationFeeChargePolicy: normalizeApplicationFeeChargePolicy(row.applicationFeeChargePolicy),
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
 * The effective application fee (cents) for one listing.
 *
 * PLAN-0924-1254 Decide: Application system fee is the ONE source of truth.
 * Listing `applicationFee` fields are retired from Pricing and are ignored
 * here (callers may still pass `listingFeeCents` for API stability; it never
 * wins). Priority: configured manager/system fee → legacy $50 when unset.
 * Pure — safe to use on client and server.
 *
 * `0` on the manager setting means applications are free. `null` means not
 * configured yet (legacy default applies until the manager saves).
 */
export function effectiveApplicationFeeCents(input: {
  managerFeeCents: number | null;
  /**
   * @deprecated Listing fees are ignored (PLAN-0924-1254). Kept so existing
   * call sites keep compiling; do not pass a value expecting it to charge.
   */
  listingFeeCents?: number | null;
}): number {
  void input.listingFeeCents;
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
