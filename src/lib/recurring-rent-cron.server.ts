import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import { planRecurringRentCharges } from "@/lib/recurring-rent-sweep";
import { persistHouseholdChargeRows, type HouseholdChargeWriteRow } from "@/lib/household-charge-persist.server";

/** Hard caps per run: a runaway profile table can never write an unbounded batch. */
export const SWEEP_MAX_PROFILES = 20_000;
export const SWEEP_MAX_NEW_CHARGES = 500;
/**
 * One read page. The sweep pages to {@link SWEEP_MAX_PROFILES} instead of taking a single
 * `limit`, because the read order is deterministic: a single page meant the profiles past
 * it were the same ones skipped every night, and nobody ever billed them.
 */
const PROFILE_PAGE_SIZE = 1000;
/**
 * Wall-clock budget for one run, well inside the route's `maxDuration`. A run that is
 * killed mid-flight reports nothing at all, so the sweep stops itself first, says how
 * many profiles it did not reach, and leaves them to the next night (the write is
 * insert-only, so continuing later costs nothing).
 */
export const SWEEP_MAX_MS = 45_000;
const MANAGER_CHARGE_READ_LIMIT = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecurringRentCronResult = {
  managers: number;
  profiles: number;
  created: number;
  skippedHeld: number;
  capped: boolean;
  /** Profiles the run stopped short of, when `capped`. The next run reaches them. */
  remaining: number;
  errors: string[];
};

function billableProfile(p: RecurringRentProfile): boolean {
  return (
    p.active &&
    (p.monthlyRent > 0 || (p.dailyRentPrice ?? 0) > 0 || (p.weeklyRentPrice ?? 0) > 0 || (p.monthlyUtilities ?? 0) > 0)
  );
}

/**
 * The browser sweep (`syncAllRecurringRentCharges`) run on the server: for every
 * manager with an active recurring rent profile, write the current and next
 * month's missing charges. Pure planning is shared with the client
 * (`planRecurringRentCharges`); writing goes through the same
 * `persistHouseholdChargeRows` the portal POST uses (insert-only, so a row that
 * already exists is never touched, and a paid row is never rewritten).
 */
export async function runRecurringRentSweep(db: SupabaseClient, now: Date = new Date()): Promise<RecurringRentCronResult> {
  const result: RecurringRentCronResult = { managers: 0, profiles: 0, created: 0, skippedHeld: 0, capped: false, remaining: 0, errors: [] };
  const deadline = Date.now() + SWEEP_MAX_MS;

  type ProfileRow = { id?: unknown; manager_user_id?: unknown; row_data?: unknown };
  const profileRows: ProfileRow[] = [];
  for (let from = 0; from < SWEEP_MAX_PROFILES; from += PROFILE_PAGE_SIZE) {
    if (Date.now() >= deadline) {
      result.capped = true;
      break;
    }
    const to = Math.min(from + PROFILE_PAGE_SIZE, SWEEP_MAX_PROFILES) - 1;
    const { data, error: profileError } = await db
      .from("portal_recurring_rent_profile_records")
      .select("id, manager_user_id, row_data")
      .eq("active", true)
      .order("updated_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (profileError) {
      result.errors.push(`profiles: ${profileError.message}`);
      return result;
    }
    const page = (data ?? []) as ProfileRow[];
    profileRows.push(...page);
    if (page.length < to - from + 1) break;
  }
  if (profileRows.length >= SWEEP_MAX_PROFILES) result.capped = true;

  const byManager = new Map<string, RecurringRentProfile[]>();
  for (const row of profileRows) {
    const managerId = row.manager_user_id ? String(row.manager_user_id) : "";
    if (!managerId || !row.row_data || typeof row.row_data !== "object") continue;
    const profile = { ...(row.row_data as RecurringRentProfile), id: String(row.id), managerUserId: managerId };
    if (typeof profile.residentEmail !== "string" || !profile.propertyId) continue;
    const list = byManager.get(managerId) ?? [];
    list.push(profile);
    byManager.set(managerId, list);
  }

  const managerQueue = [...byManager.entries()];
  for (let index = 0; index < managerQueue.length; index += 1) {
    const [managerId, managerProfiles] = managerQueue[index]!;
    if (result.created >= SWEEP_MAX_NEW_CHARGES || Date.now() >= deadline) {
      result.capped = true;
      result.remaining = managerQueue.slice(index).reduce((total, [, list]) => total + list.length, 0);
      console.warn("[recurring-rent-cron] sweep capped", {
        managers: result.managers,
        created: result.created,
        remainingProfiles: result.remaining,
      });
      break;
    }
    result.managers += 1;
    try {
      const { data: holdRows, error: holdError } = await db
        .from("manager_application_records")
        .select("resident_email")
        .eq("manager_user_id", managerId)
        .eq("row_data->>migrationBillingHold", "true")
        .limit(5000);
      // A hold we could not read is not "no hold": skip this manager rather than bill an imported tenant twice.
      if (holdError) {
        result.errors.push(`holds ${managerId}: ${holdError.message}`);
        continue;
      }
      const held = new Set((holdRows ?? []).map((r) => String(r.resident_email ?? "").trim().toLowerCase()));
      const eligible = managerProfiles.filter((p) => {
        const isHeld = held.has(p.residentEmail.trim().toLowerCase());
        if (isHeld) result.skippedHeld += 1;
        return !isHeld && billableProfile(p);
      });
      if (eligible.length === 0) continue;
      result.profiles += eligible.length;

      const { data: chargeRows, error: chargeError } = await db
        .from("portal_household_charge_records")
        .select("id, row_data")
        .eq("manager_user_id", managerId)
        .limit(MANAGER_CHARGE_READ_LIMIT);
      if (chargeError) {
        result.errors.push(`charges ${managerId}: ${chargeError.message}`);
        continue;
      }
      const existing = (chargeRows ?? [])
        .filter((r) => r.row_data && typeof r.row_data === "object")
        .map((r) => ({ ...(r.row_data as HouseholdCharge), id: String(r.id), managerUserId: managerId }));
      const existingIds = new Set(existing.map((c) => c.id));

      const { newCharges } = planRecurringRentCharges({ profiles: eligible, existing, now });
      const fresh = newCharges.filter((c) => !existingIds.has(c.id)).slice(0, Math.max(0, SWEEP_MAX_NEW_CHARGES - result.created));
      if (fresh.length === 0) continue;

      const stamp = now.toISOString();
      const rows: HouseholdChargeWriteRow[] = fresh.map((c) => ({
        id: c.id,
        manager_user_id: managerId,
        resident_user_id: c.residentUserId && UUID.test(c.residentUserId) ? c.residentUserId : null,
        resident_email: c.residentEmail.trim().toLowerCase(),
        property_id: c.propertyId || null,
        kind: c.kind,
        status: "pending",
        row_data: { ...c, managerUserId: managerId, status: "pending", balanceLabel: c.amountLabel } as unknown as Record<string, unknown>,
        updated_at: stamp,
      }));
      const { persistedRows, chargeWriteError } = await persistHouseholdChargeRows(db, rows, {
        actor: { id: managerId, role: "manager" },
        now: stamp,
        chargeIds: rows.map((r) => r.id),
        previousStatusById: new Map(),
        existingOwnerById: new Map(),
        existingUpdatedAtById: new Map(),
        existingRecordById: new Map(),
        existingLedgerFingerprintById: new Map(),
      });
      result.created += persistedRows.length;
      if (chargeWriteError) result.errors.push(`write ${managerId}: ${chargeWriteError}`);
    } catch (e) {
      result.errors.push(`manager ${managerId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
