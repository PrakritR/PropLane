import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";

/**
 * Vendor availability: recurring weekly windows + one-off blocked dates, and
 * the pure slot-resolution algorithm managers use to auto-schedule a visit
 * into a vendor's next open slot. Wall-clock math is done in the vendor's
 * operating timezone (Pacific, matching the rest of the portal's scheduling
 * UI) rather than the server process's local timezone, so a "9am-5pm" window
 * means 9am-5pm Pacific regardless of where the Node process runs.
 */
export type VendorAvailabilityRule =
  | { id: string; kind: "weekly"; weekday: number; startMinute: number; endMinute: number; note?: string | null }
  | { id: string; kind: "block"; specificDate: string; startMinute: number; endMinute: number; note?: string | null }
  | { id: string; kind: "open"; specificDate: string; startMinute: number; endMinute: number; note?: string | null }
  | { id: string; kind: "event"; specificDate: string; startMinute: number; endMinute: number; note?: string | null };

/** Prefix for calendar meeting ids backed by a vendor `event` availability rule. */
export const VENDOR_WORK_MEETING_ID_PREFIX = "vendor-work-";

export const DEFAULT_VISIT_DURATION_MINUTES = 60;
export const SLOT_STEP_MINUTES = 30;
export const MINUTES_PER_DAY = 1440;

const VENDOR_AVAILABILITY_TTL_MS = 15_000;

export type VendorFlexibleTiming = "morning" | "afternoon" | "evening";

export const VENDOR_FLEXIBLE_TIMING_LABELS: Record<VendorFlexibleTiming, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

/** Default preference order when a vendor has not customized ranking. */
export const DEFAULT_FLEXIBLE_TIMING_RANK: VendorFlexibleTiming[] = ["morning", "afternoon", "evening"];

/** Pacific wall-clock ranges for flexible-day auto-scheduling. */
export const FLEXIBLE_TIMING_RANGES: Record<VendorFlexibleTiming, { start: number; end: number }> = {
  morning: { start: 8 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
  evening: { start: 17 * 60, end: 21 * 60 },
};

export type VendorFlexiblePreferences = {
  timingRank: VendorFlexibleTiming[];
};

export function normalizeFlexibleTimingRank(raw: unknown): VendorFlexibleTiming[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FLEXIBLE_TIMING_RANK];
  const allowed = new Set<VendorFlexibleTiming>(["morning", "afternoon", "evening"]);
  const seen = new Set<VendorFlexibleTiming>();
  const rank: VendorFlexibleTiming[] = [];
  for (const item of raw) {
    const key = String(item).toLowerCase() as VendorFlexibleTiming;
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    rank.push(key);
  }
  for (const fallback of DEFAULT_FLEXIBLE_TIMING_RANK) {
    if (!seen.has(fallback)) rank.push(fallback);
  }
  return rank;
}

/** Merge 30-minute slot keys (`YYYY-MM-DD:slotIndex`) into contiguous minute windows per date. */
export function mergeSlotKeysToDateWindows(keys: Iterable<string>): Map<string, Array<{ start: number; end: number }>> {
  const byDate = new Map<string, number[]>();
  for (const key of keys) {
    const [dateStr, slotStr] = key.split(":");
    if (!dateStr || slotStr === undefined) continue;
    const slot = Number(slotStr);
    if (!Number.isFinite(slot) || slot < 0) continue;
    const list = byDate.get(dateStr) ?? [];
    list.push(slot);
    byDate.set(dateStr, list);
  }

  const result = new Map<string, Array<{ start: number; end: number }>>();
  for (const [dateStr, slots] of byDate) {
    slots.sort((a, b) => a - b);
    const windows: Array<{ start: number; end: number }> = [];
    let runStart = slots[0]! * SLOT_STEP_MINUTES;
    let runEnd = runStart + SLOT_STEP_MINUTES;
    for (let i = 1; i < slots.length; i += 1) {
      const start = slots[i]! * SLOT_STEP_MINUTES;
      if (start === runEnd) {
        runEnd += SLOT_STEP_MINUTES;
      } else {
        windows.push({ start: runStart, end: runEnd });
        runStart = start;
        runEnd = start + SLOT_STEP_MINUTES;
      }
    }
    windows.push({ start: runStart, end: runEnd });
    result.set(dateStr, windows);
  }
  return result;
}

export function flexibleWeekdaysFromRules(rules: VendorAvailabilityRule[]): Set<number> {
  const out = new Set<number>();
  for (const rule of rules) {
    if (rule.kind === "weekly" && isFlexibleWeeklyRule(rule)) out.add(rule.weekday);
  }
  return out;
}

function windowsForFlexibleDay(timingRank: VendorFlexibleTiming[]): Array<{ start: number; end: number }> {
  return timingRank.map((period) => FLEXIBLE_TIMING_RANGES[period]);
}

function slotFits(
  y: number,
  m: number,
  d: number,
  cursor: number,
  durationMinutes: number,
  exclusions: Array<{ start: number; end: number }>,
): string | null {
  const blocking = exclusions.find((ex) => cursor < ex.end && cursor + durationMinutes > ex.start);
  if (!blocking) return pacificWallClockToUtc(y, m, d, cursor).toISOString();
  return null;
}

function overlapsBusy(busy: BusyWindow[], startIso: string, durationMinutes: number): boolean {
  const start = new Date(startIso).getTime();
  const end = start + durationMinutes * 60_000;
  return busy.some((window) => {
    const bStart = new Date(window.startIso).getTime();
    const bEnd = new Date(window.endIso).getTime();
    return start < bEnd && end > bStart;
  });
}

const TIME_ZONE = "America/Los_Angeles";
const WEEKDAY_FROM_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Display order (Mon..Sun) of the JS Date#getDay() weekday values this module stores. */
export const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAY_LABELS: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

export function pacificDateTimeParts(date: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) map[part.type] = part.value;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: WEEKDAY_FROM_SHORT[map.weekday] ?? 0,
  };
}

/** Pacific wall-clock (year, month 1-12, day, minuteOfDay) -> the UTC instant it corresponds to. */
export function pacificWallClockToUtc(year: number, month: number, day: number, minuteOfDay: number): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  // Two correction passes converge reliably since the Pacific/UTC offset is a
  // stable integer number of hours except across the DST-transition instant itself.
  for (let i = 0; i < 2; i += 1) {
    const parts = pacificDateTimeParts(guess);
    const dayDiffMs = Date.UTC(year, month - 1, day) - Date.UTC(parts.year, parts.month - 1, parts.day);
    const minuteDiffMs = (minuteOfDay - (parts.hour * 60 + parts.minute)) * 60_000;
    guess = new Date(guess.getTime() + dayDiffMs + minuteDiffMs);
  }
  return guess;
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function minuteOfDayToTimeInputValue(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function timeInputValueToMinuteOfDay(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function formatMinuteOfDayLabel(minute: number): string {
  const h24 = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

type BusyWindow = { startIso: string; endIso: string };

/**
 * Walk forward day-by-day from `from`, returning the ISO start of the first
 * slot of `durationMinutes` that falls inside a weekly window, isn't covered
 * by a block rule for that date, and doesn't overlap any busy window
 * (existing scheduled visits). Returns null if nothing opens up within
 * `daysToSearch` days.
 */
export function resolveNextAvailableSlot(options: {
  rules: VendorAvailabilityRule[];
  busy: BusyWindow[];
  durationMinutes?: number;
  from?: Date;
  daysToSearch?: number;
  /** Drag-painted open slots from the vendor calendar grid. */
  slotKeys?: Iterable<string>;
  /** Weekdays (0=Sun) marked flexible — uses timingRank windows when no explicit slots exist. */
  flexibleWeekdays?: Set<number>;
  timingRank?: VendorFlexibleTiming[];
  /** Tenant-requested time takes priority when it fits availability and is not busy. */
  tenantPreferredIso?: string | null;
}): string | null {
  const {
    rules,
    busy,
    durationMinutes = DEFAULT_VISIT_DURATION_MINUTES,
    from = new Date(),
    daysToSearch = 60,
    slotKeys,
    flexibleWeekdays,
    timingRank = DEFAULT_FLEXIBLE_TIMING_RANK,
    tenantPreferredIso,
  } = options;

  if (tenantPreferredIso) {
    const preferred = new Date(tenantPreferredIso);
    if (!Number.isNaN(preferred.getTime()) && !overlapsBusy(busy, preferred.toISOString(), durationMinutes)) {
      const parts = pacificDateTimeParts(preferred);
      const minute = parts.hour * 60 + parts.minute;
      const key = dateKey(parts.year, parts.month, parts.day);
      const weekday = preferred.getUTCDay();
      const slotWindows = mergeSlotKeysToDateWindows(slotKeys ?? []);
      const explicit = slotWindows.get(key) ?? [];
      const flex = flexibleWeekdays?.has(weekday) ? windowsForFlexibleDay(timingRank) : [];
      const weeklyByWeekday = new Map<number, Array<{ start: number; end: number }>>();
      const opensByDate = new Map<string, Array<{ start: number; end: number }>>();
      for (const rule of rules) {
        if (rule.kind === "weekly" && !isFlexibleWeeklyRule(rule)) {
          const list = weeklyByWeekday.get(rule.weekday) ?? [];
          list.push({ start: rule.startMinute, end: rule.endMinute });
          weeklyByWeekday.set(rule.weekday, list);
        } else if (rule.kind === "open") {
          const list = opensByDate.get(rule.specificDate) ?? [];
          list.push({ start: rule.startMinute, end: rule.endMinute });
          opensByDate.set(rule.specificDate, list);
        }
      }
      const windows = [...explicit, ...flex, ...(weeklyByWeekday.get(weekday) ?? []), ...(opensByDate.get(key) ?? [])];
      const blocksByDate = new Map<string, Array<{ start: number; end: number }>>();
      for (const rule of rules) {
        if (rule.kind === "block") {
          const list = blocksByDate.get(rule.specificDate) ?? [];
          list.push({ start: rule.startMinute, end: rule.endMinute });
          blocksByDate.set(rule.specificDate, list);
        }
      }
      const blocks = blocksByDate.get(key) ?? [];
      const inWindow = windows.some((w) => minute >= w.start && minute + durationMinutes <= w.end);
      const inBlock = blocks.some((b) => minute < b.end && minute + durationMinutes > b.start);
      if (inWindow && !inBlock) return preferred.toISOString();
    }
  }

  const slotWindows = mergeSlotKeysToDateWindows(slotKeys ?? []);

  const weeklyByWeekday = new Map<number, Array<{ start: number; end: number }>>();
  const blocksByDate = new Map<string, Array<{ start: number; end: number }>>();
  const opensByDate = new Map<string, Array<{ start: number; end: number }>>();
  for (const rule of rules) {
    if (rule.kind === "weekly" && !isFlexibleWeeklyRule(rule)) {
      const list = weeklyByWeekday.get(rule.weekday) ?? [];
      list.push({ start: rule.startMinute, end: rule.endMinute });
      weeklyByWeekday.set(rule.weekday, list);
    } else if (rule.kind === "block") {
      const list = blocksByDate.get(rule.specificDate) ?? [];
      list.push({ start: rule.startMinute, end: rule.endMinute });
      blocksByDate.set(rule.specificDate, list);
    } else if (rule.kind === "open") {
      const list = opensByDate.get(rule.specificDate) ?? [];
      list.push({ start: rule.startMinute, end: rule.endMinute });
      opensByDate.set(rule.specificDate, list);
    }
  }

  const busyByDate = new Map<string, Array<{ start: number; end: number }>>();
  for (const window of busy) {
    const start = pacificDateTimeParts(new Date(window.startIso));
    const end = pacificDateTimeParts(new Date(window.endIso));
    const key = dateKey(start.year, start.month, start.day);
    const startMinute = start.hour * 60 + start.minute;
    const sameDay = dateKey(end.year, end.month, end.day) === key;
    const endMinute = sameDay ? end.hour * 60 + end.minute : MINUTES_PER_DAY;
    const list = busyByDate.get(key) ?? [];
    list.push({ start: startMinute, end: endMinute });
    busyByDate.set(key, list);
  }

  const fromParts = pacificDateTimeParts(from);
  const fromMinuteFloor = fromParts.hour * 60 + fromParts.minute;
  const fromUtcMidnight = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);

  for (let dayOffset = 0; dayOffset < daysToSearch; dayOffset += 1) {
    const candidate = new Date(fromUtcMidnight + dayOffset * 86_400_000);
    const y = candidate.getUTCFullYear();
    const m = candidate.getUTCMonth() + 1;
    const d = candidate.getUTCDate();
    const weekday = candidate.getUTCDay();
    const key = dateKey(y, m, d);

    const explicitSlots = slotWindows.get(key) ?? [];
    const flexWindows = flexibleWeekdays?.has(weekday) ? windowsForFlexibleDay(timingRank) : [];
    const windows = [
      ...explicitSlots,
      ...flexWindows,
      ...(weeklyByWeekday.get(weekday) ?? []),
      ...(opensByDate.get(key) ?? []),
    ];
    if (windows.length === 0) continue;

    const exclusions = [...(blocksByDate.get(key) ?? []), ...(busyByDate.get(key) ?? [])].sort((a, b) => a.start - b.start);
    const dayFloor = dayOffset === 0 ? fromMinuteFloor : 0;

    const orderedWindows =
      flexWindows.length > 0 && explicitSlots.length === 0
        ? timingRank.flatMap((period) => {
            const range = FLEXIBLE_TIMING_RANGES[period];
            return [{ start: range.start, end: range.end }];
          })
        : [...windows].sort((a, b) => a.start - b.start);

    for (const window of orderedWindows) {
      let cursor = Math.ceil(Math.max(window.start, dayFloor) / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES;
      while (cursor + durationMinutes <= window.end) {
        const fit = slotFits(y, m, d, cursor, durationMinutes, exclusions);
        if (fit && !overlapsBusy(busy, fit, durationMinutes)) return fit;
        const blocking = exclusions.find((ex) => cursor < ex.end && cursor + durationMinutes > ex.start);
        cursor = blocking
          ? Math.ceil(blocking.end / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES
          : cursor + SLOT_STEP_MINUTES;
      }
    }
  }
  return null;
}

type AvailabilityRefreshEntry = {
  rules: VendorAvailabilityRule[] | null;
  loadedAt: number;
  refresher: CoalescedRefresher<VendorAvailabilityRule[]>;
};

const availabilityRefreshEntries = new Map<string, AvailabilityRefreshEntry>();

type VendorAvailabilityReadOptions = { force?: boolean; viewerId?: string };

function vendorAvailabilityRefreshKey(vendorId?: string, viewerId?: string): string {
  // The endpoint is authorization-scoped: never reuse a prior viewer's rules
  // during the TTL window after sign-out/sign-in.
  const viewer = viewerId?.trim() || "anonymous";
  return vendorId?.trim() ? `viewer:${viewer}:vendor:${vendorId.trim()}` : `viewer:${viewer}:self`;
}

function availabilityRefreshEntry(vendorId?: string, viewerId?: string): AvailabilityRefreshEntry {
  const key = vendorAvailabilityRefreshKey(vendorId, viewerId);
  const existing = availabilityRefreshEntries.get(key);
  if (existing) return existing;
  const url = vendorId ? `/api/vendor/availability?vendorId=${encodeURIComponent(vendorId)}` : "/api/vendor/availability";
  const entry: AvailabilityRefreshEntry = {
    rules: null,
    loadedAt: 0,
    refresher: null as unknown as CoalescedRefresher<VendorAvailabilityRule[]>,
  };
  entry.refresher = createCoalescedRefresher(async () => {
    try {
      const res = await fetch(url, { credentials: "include" });
      const data = res.ok ? await res.json() : null;
      const rules = Array.isArray(data?.rules) ? (data.rules as VendorAvailabilityRule[]) : [];
      entry.rules = rules;
      entry.loadedAt = Date.now();
      return rules;
    } catch {
      entry.rules = [];
      entry.loadedAt = Date.now();
      return [];
    }
  });
  availabilityRefreshEntries.set(key, entry);
  return entry;
}

export function invalidateVendorAvailability(vendorId?: string, viewerId?: string): void {
  const entry = availabilityRefreshEntries.get(vendorAvailabilityRefreshKey(vendorId, viewerId));
  if (!entry) return;
  entry.rules = null;
  entry.loadedAt = 0;
}

/**
 * Drops every cached/in-flight availability entry. Production code never
 * needs this — the TTL and `invalidateVendorAvailability` already cover real
 * usage — but tests that render the availability editor more than once in
 * the same module instance need a way to stop an earlier render's cache
 * from swallowing a later render's fetch.
 */
export function resetVendorAvailabilityCacheForTests(): void {
  availabilityRefreshEntries.clear();
}

export async function fetchVendorAvailability(vendorId?: string, opts: VendorAvailabilityReadOptions = {}): Promise<VendorAvailabilityRule[]> {
  const entry = availabilityRefreshEntry(vendorId, opts.viewerId);
  if (!opts.force && entry.rules && Date.now() - entry.loadedAt < VENDOR_AVAILABILITY_TTL_MS) return entry.rules;
  return entry.refresher.run(Boolean(opts.force));
}

async function postAvailability(body: Record<string, unknown>): Promise<{ ok: boolean; rule?: VendorAvailabilityRule; error?: string }> {
  try {
    const res = await fetch("/api/vendor/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error ?? "Request failed." };
    invalidateVendorAvailability();
    return { ok: true, rule: data.rule };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export function saveVendorWeeklyRule(input: {
  id?: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  note?: string;
}) {
  return postAvailability({ action: "upsert-weekly", ...input });
}

export function isFlexibleWeeklyRule(rule: VendorAvailabilityRule): boolean {
  return rule.kind === "weekly" && (rule.note?.trim().toLowerCase() ?? "") === "flexible";
}

export function saveVendorBlockRule(input: { id?: string; specificDate: string; startMinute?: number; endMinute?: number; note?: string }) {
  return postAvailability({ action: "upsert-block", ...input });
}

export function saveVendorDateRule(input: { id?: string; specificDate: string; startMinute?: number; endMinute?: number; note?: string }) {
  return postAvailability({ action: "upsert-open", ...input });
}

export function saveVendorEventRule(input: {
  id?: string;
  specificDate: string;
  startMinute: number;
  endMinute: number;
  note?: string;
}) {
  return postAvailability({ action: "upsert-event", ...input });
}

export function vendorEventRulesToBusyWindows(rules: VendorAvailabilityRule[]): BusyWindow[] {
  const out: BusyWindow[] = [];
  for (const rule of rules) {
    if (rule.kind !== "event") continue;
    const [year, month, day] = rule.specificDate.split("-").map(Number);
    if (!year || !month || !day) continue;
    const start = new Date(year, month - 1, day, 0, 0, 0, 0);
    start.setMinutes(rule.startMinute);
    const end = new Date(year, month - 1, day, 0, 0, 0, 0);
    end.setMinutes(rule.endMinute);
    out.push({ startIso: start.toISOString(), endIso: end.toISOString() });
  }
  return out;
}

export function isVendorWorkMeetingId(meetingId: string): boolean {
  return meetingId.startsWith(VENDOR_WORK_MEETING_ID_PREFIX);
}

export function deleteVendorAvailabilityRule(id: string) {
  return postAvailability({ action: "delete", id });
}

/** Turn leftover Flexible all-day weekly flags into 8am–6pm open windows. */
export async function convertFlexibleWeeklyRulesToWindows(
  rules: VendorAvailabilityRule[],
): Promise<VendorAvailabilityRule[] | null> {
  const flexible = rules.filter(
    (rule): rule is Extract<VendorAvailabilityRule, { kind: "weekly" }> => isFlexibleWeeklyRule(rule),
  );
  if (flexible.length === 0) return null;
  for (const rule of flexible) {
    const result = await saveVendorWeeklyRule({
      id: rule.id,
      weekday: rule.weekday,
      startMinute: 8 * 60,
      endMinute: 18 * 60,
    });
    if (!result.ok) return null;
  }
  return fetchVendorAvailability();
}

/** Paint weekly open windows onto the manager-style slot grid for the next N weeks. */
export function slotKeysFromWeeklyRules(
  rules: VendorAvailabilityRule[],
  from: Date,
  weekCount: number,
): string[] {
  const windows = rules.filter(
    (rule): rule is Extract<VendorAvailabilityRule, { kind: "weekly" }> =>
      rule.kind === "weekly" && !isFlexibleWeeklyRule(rule),
  );
  if (windows.length === 0) return [];
  const keys: string[] = [];
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const days = Math.max(0, weekCount) * 7;
  for (let i = 0; i < days; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const weekday = day.getDay();
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    for (const rule of windows) {
      if (rule.weekday !== weekday) continue;
      const startSlot = Math.floor(rule.startMinute / SLOT_STEP_MINUTES);
      const endSlot = Math.ceil(rule.endMinute / SLOT_STEP_MINUTES);
      for (let slot = startSlot; slot < endSlot; slot += 1) {
        keys.push(`${dateStr}:${slot}`);
      }
    }
  }
  return keys;
}

export async function fetchVendorFlexiblePreferences(): Promise<VendorFlexiblePreferences> {
  try {
    const res = await fetch("/api/vendor/availability?preferences=1", { credentials: "include" });
    if (!res.ok) return { timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK] };
    const data = await res.json();
    return { timingRank: normalizeFlexibleTimingRank(data.preferences?.timingRank) };
  } catch {
    return { timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK] };
  }
}

export function saveVendorFlexiblePreferences(preferences: VendorFlexiblePreferences) {
  return postAvailability({
    action: "save-preferences",
    timingRank: normalizeFlexibleTimingRank(preferences.timingRank),
  });
}

export function readVendorFlexiblePreferencesFromStorage(userId: string): VendorFlexiblePreferences {
  if (typeof window === "undefined" || !userId.trim()) {
    return { timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK] };
  }
  try {
    const raw = window.sessionStorage.getItem(`axis_vendor_flex_prefs_${userId}`);
    if (!raw) return { timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK] };
    const parsed = JSON.parse(raw) as { timingRank?: unknown };
    return { timingRank: normalizeFlexibleTimingRank(parsed.timingRank) };
  } catch {
    return { timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK] };
  }
}

export function writeVendorFlexiblePreferencesToStorage(userId: string, preferences: VendorFlexiblePreferences): void {
  if (typeof window === "undefined" || !userId.trim()) return;
  try {
    window.sessionStorage.setItem(
      `axis_vendor_flex_prefs_${userId}`,
      JSON.stringify({ timingRank: normalizeFlexibleTimingRank(preferences.timingRank) }),
    );
  } catch {
    /* ignore */
  }
}
