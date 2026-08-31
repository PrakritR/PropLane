/**
 * Per-manager tour scheduling settings.
 *
 * `tourNoticeDays` is how much notice the manager needs before a tour, in whole calendar days.
 * `0` (the default) keeps same-day tours available; `3` means a prospect's soonest bookable day
 * is three days out. The day arithmetic and the reason it is days rather than hours live in
 * `tour-slot-math.ts` (`earliestBookableTourDate`) — this module only stores and loads the number.
 *
 * Stored on `manager_automation_settings.row_data.tourSettings`, alongside `applicationSettings`
 * and `applicationAutomation`, for the same reason: that table always has a `row_data` JSON column,
 * so this needs no migration and cannot break on a production project whose columns lag dev. Writes
 * merge into the existing blob rather than replacing it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_HORIZON_DAYS,
  DEFAULT_TOUR_NOTICE_DAYS,
  DEFAULT_TOUR_START_SLOT,
  normalizeTourNoticeDays,
  type DefaultTourAvailabilityConfig,
  resolveDefaultTourAvailabilityConfig,
} from "@/lib/tour-slot-math";

export type ManagerTourSettings = {
  /** Whole calendar days of notice required before a tour. 0 = same-day allowed. */
  tourNoticeDays: number;
  /** First default bookable window (30-min slot index). Absent = 9:00 am Pacific. */
  defaultTourStartSlot?: number;
  /** End of default windows (exclusive slot index). Absent = 5:00 pm Pacific. */
  defaultTourEndSlotExclusive?: number;
  /** How many days ahead the implicit default grid is offered when nothing is published. */
  defaultTourHorizonDays?: number;
  /** When false, an empty calendar offers no default windows to prospects. */
  defaultTourGridEnabled?: boolean;
};

export const DEFAULT_MANAGER_TOUR_SETTINGS: ManagerTourSettings = {
  tourNoticeDays: DEFAULT_TOUR_NOTICE_DAYS,
  defaultTourStartSlot: DEFAULT_TOUR_START_SLOT,
  defaultTourEndSlotExclusive: DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  defaultTourHorizonDays: DEFAULT_TOUR_HORIZON_DAYS,
};

export function managerTourSettingsToDefaultAvailability(
  settings: ManagerTourSettings,
): DefaultTourAvailabilityConfig {
  return resolveDefaultTourAvailabilityConfig({
    startSlot: settings.defaultTourStartSlot,
    endSlotExclusive: settings.defaultTourEndSlotExclusive,
    horizonDays: settings.defaultTourHorizonDays,
    enabled: settings.defaultTourGridEnabled !== false,
  });
}

const ROW_DATA_KEY = "tourSettings";

function normalizeSlotIndex(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(48, Math.trunc(n)));
}

function normalizeHorizonDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_TOUR_HORIZON_DAYS;
  return Math.max(7, Math.min(60, Math.trunc(n)));
}

export function normalizeManagerTourSettings(raw: unknown): ManagerTourSettings {
  const row = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const startSlot = normalizeSlotIndex(row.defaultTourStartSlot, DEFAULT_TOUR_START_SLOT);
  const endSlotExclusive = normalizeSlotIndex(
    row.defaultTourEndSlotExclusive,
    DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  );
  return {
    tourNoticeDays: normalizeTourNoticeDays(row.tourNoticeDays),
    defaultTourStartSlot: startSlot,
    defaultTourEndSlotExclusive: Math.max(startSlot + 1, endSlotExclusive),
    defaultTourHorizonDays: normalizeHorizonDays(row.defaultTourHorizonDays),
    defaultTourGridEnabled: row.defaultTourGridEnabled !== false,
  };
}

export async function loadManagerTourSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ManagerTourSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeManagerTourSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

/**
 * Notice days for several managers at once, for the public availability route — it renders one
 * grid across every manager offering that property, and a per-manager round trip would be a query
 * per offering on an anonymous, deliberately uncached endpoint.
 *
 * A manager with no row, or a read that fails, is reported as the DEFAULT (no notice) rather than
 * omitted: the caller uses this to filter slots, and a missing entry would read as "no notice"
 * anyway. Callers that must not fail open should check `ok`.
 */
export async function loadTourSettingsByManager(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<{ ok: boolean; settingsByManager: Map<string, ManagerTourSettings> }> {
  const settingsByManager = new Map<string, ManagerTourSettings>();
  const ids = [...new Set(managerUserIds.filter((id) => id?.trim()))];
  if (ids.length === 0) return { ok: true, settingsByManager };
  try {
    const { data, error } = await db
      .from("manager_automation_settings")
      .select("manager_user_id, row_data")
      .in("manager_user_id", ids);
    if (error) return { ok: false, settingsByManager };
    for (const row of (data ?? []) as { manager_user_id?: string | null; row_data?: unknown }[]) {
      if (!row.manager_user_id) continue;
      settingsByManager.set(
        row.manager_user_id,
        normalizeManagerTourSettings((row.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]),
      );
    }
    return { ok: true, settingsByManager };
  } catch {
    return { ok: false, settingsByManager };
  }
}

export async function loadTourNoticeDaysByManager(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<{ ok: boolean; noticeDays: Map<string, number> }> {
  const noticeDays = new Map<string, number>();
  const ids = [...new Set(managerUserIds.filter((id) => id?.trim()))];
  if (ids.length === 0) return { ok: true, noticeDays };
  try {
    const { data, error } = await db
      .from("manager_automation_settings")
      .select("manager_user_id, row_data")
      .in("manager_user_id", ids);
    if (error) return { ok: false, noticeDays };
    for (const row of (data ?? []) as { manager_user_id?: string | null; row_data?: unknown }[]) {
      if (!row.manager_user_id) continue;
      const settings = normalizeManagerTourSettings(
        (row.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY],
      );
      noticeDays.set(row.manager_user_id, settings.tourNoticeDays);
    }
    return { ok: true, noticeDays };
  } catch {
    // This runs on the PUBLIC booking page. A settings read that throws must not take the whole
    // availability grid down with it — losing the notice window is a smaller failure than a
    // prospect who cannot book at all. Same fail-open trade the route already makes for a
    // Google Calendar outage, and `ok: false` lets a caller that cares tell the difference.
    return { ok: false, noticeDays };
  }
}

export async function saveManagerTourSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: unknown,
): Promise<ManagerTourSettings> {
  // Read-modify-write: replacing `row_data` outright would take the manager's application fee
  // and automation flags with it.
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const existingTourSettings = normalizeManagerTourSettings(rowData[ROW_DATA_KEY]);
  const patch =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const normalized = normalizeManagerTourSettings({ ...existingTourSettings, ...patch });
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
