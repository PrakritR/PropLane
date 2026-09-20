import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The manager-side "Rent reporting" add-on switch (Settings → Billing & plan → Add-ons).
 *
 * This is deliberately NOT one of `PLAN_ADDONS` (`src/lib/plan-addons.ts`): that catalogue
 * is a manager-CHOSEN quantity wired to a Stripe subscription item per unit (extra
 * listings, seats…). Rent reporting's cost scales with however many residents opt in
 * this month — a count the manager does not choose — so it is a simple On/Off switch
 * with its own billing note (see `docs/agents/rent-reporting.md` "Billing").
 *
 * Stored on `manager_automation_settings.row_data.rentReportingAddon`, the same
 * no-migration-needed pattern `manager-tour-settings.ts` and friends use: that table
 * always has a `row_data` JSON column, so a new toggle needs no schema change and a
 * save merges into the existing blob rather than replacing it.
 */

export type RentReportingAddonSettings = {
  enabled: boolean;
};

export const DEFAULT_RENT_REPORTING_ADDON_SETTINGS: RentReportingAddonSettings = { enabled: false };

const ROW_DATA_KEY = "rentReportingAddon";

export function normalizeRentReportingAddonSettings(raw: unknown): RentReportingAddonSettings {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { enabled: row.enabled === true };
}

export async function loadRentReportingAddonSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<RentReportingAddonSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeRentReportingAddonSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

export async function saveRentReportingAddonEnabled(
  db: SupabaseClient,
  managerUserId: string,
  enabled: boolean,
): Promise<RentReportingAddonSettings> {
  // Read-modify-write: replacing `row_data` outright would take every other automation
  // setting on this manager's row with it.
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const next: RentReportingAddonSettings = { enabled };
  rowData[ROW_DATA_KEY] = next;
  const { error } = await db
    .from("manager_automation_settings")
    .upsert({ manager_user_id: managerUserId, row_data: rowData }, { onConflict: "manager_user_id" });
  if (error) throw new Error(error.message);
  return next;
}

/** Residents currently enrolled (`status = 'active'`) under this manager. */
export async function countActiveRentReportingResidents(db: SupabaseClient, managerUserId: string): Promise<number> {
  const { count, error } = await db
    .from("resident_rent_reporting")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", managerUserId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Current paying households under this manager — the denominator for "Residents
 * reporting · 4 of 11". An active recurring rent profile is the same definition of
 * "a resident who currently owes rent here" the payments reminders cron already uses.
 */
export async function countCurrentRentPayingResidents(db: SupabaseClient, managerUserId: string): Promise<number> {
  const { data, error } = await db
    .from("portal_recurring_rent_profile_records")
    .select("resident_user_id, resident_email")
    .eq("manager_user_id", managerUserId)
    .eq("active", true);
  if (error) throw new Error(error.message);
  const keys = new Set<string>();
  for (const row of data ?? []) {
    const key = (row.resident_user_id as string | null) ?? (row.resident_email as string | null);
    if (key) keys.add(key);
  }
  return keys.size;
}
