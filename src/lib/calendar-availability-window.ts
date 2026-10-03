/**
 * The "Add availability" popup's model (studio-redesign-0929: C2-CALA1 to CALA7).
 *
 * Storage is still the per-kind slot sets (`YYYY-MM-DD:slot`), so every other
 * reader (the public tour route, `listOpenTourSlots`, the reschedule and
 * schedule-a-tour popups) keeps working untouched. This module turns the
 * popup's fields into the slot keys that Save writes, and back into the
 * "week preview" the popup draws, so the preview is the exact set of bands
 * Save will create.
 *
 * "Every week" is written as dated slots for the next {@link EVERY_WEEK_HORIZON_WEEKS}
 * weeks. That keeps Clear week honest (it clears only the viewed week and leaves
 * every other week alone) without a recurrence rule the tour readers don't know.
 */
import {
  AVAILABILITY_KINDS,
  type AvailabilityKind,
} from "@/lib/manager-availability-kinds";
import { defaultTourSlotExclusionKey } from "@/lib/tour-slot-math";

export type AvailabilityKindChoice = "tours" | "services" | "inspections" | "moves" | "everything";

export const AVAILABILITY_KIND_CHOICES: ReadonlyArray<{ value: AvailabilityKindChoice; label: string }> = [
  { value: "tours", label: "Tours" },
  { value: "services", label: "Services and vendor visits" },
  { value: "inspections", label: "Inspections" },
  { value: "moves", label: "Move-ins and move-outs" },
  { value: "everything", label: "Everything" },
];

/** Weeks an "Every week" window is written for. */
export const EVERY_WEEK_HORIZON_WEEKS = 26;

export const ALL_HOUSES = "all";

/**
 * Multi-select where one entry (Everything / All houses) is exclusive of the
 * specific picks (C2-CALA2). Ticking the exclusive entry clears the rest;
 * ticking a specific entry clears the exclusive one; unticking the last entry
 * falls back to the exclusive one so the field is never empty.
 */
export function toggleExclusiveChoice(
  current: readonly string[],
  value: string,
  checked: boolean,
  exclusive: string,
): string[] {
  if (checked) {
    if (value === exclusive) return [exclusive];
    return [...current.filter((entry) => entry !== exclusive && entry !== value), value];
  }
  const next = current.filter((entry) => entry !== value);
  return next.length === 0 ? [exclusive] : next;
}

/** Kinds a set of popup choices writes to. Everything is every kind, Tasks included. */
export function storageKindsForChoices(choices: readonly AvailabilityKindChoice[]): AvailabilityKind[] {
  if (choices.length === 0 || choices.includes("everything")) return [...AVAILABILITY_KINDS];
  return AVAILABILITY_KINDS.filter((kind) => (choices as readonly string[]).includes(kind));
}

/** The popup choices that describe a stored run's kinds (the inverse used when a band is clicked). */
export function choicesForStorageKinds(kinds: readonly AvailabilityKind[]): AvailabilityKindChoice[] {
  if (AVAILABILITY_KINDS.every((kind) => kinds.includes(kind))) return ["everything"];
  const picks = (["tours", "services", "inspections", "moves"] as const).filter((kind) => kinds.includes(kind));
  return picks.length > 0 ? [...picks] : ["everything"];
}

export type AvailabilityDraft = {
  kinds: AvailabilityKindChoice[];
  on: "days" | "date";
  /** Monday-based: 0 = Mon … 6 = Sun. */
  weekdays: number[];
  /** `YYYY-MM-DD`, used when `on === "date"`. */
  date: string;
  repeat: "weekly" | "week";
  /** Half-hour slot indices (0 … 47) and an exclusive end (1 … 48). */
  startSlot: number;
  endSlotExclusive: number;
  /** `["all"]` is every house; otherwise the picked property ids. */
  propertyIds: string[];
  /** Monday (`YYYY-MM-DD`) of the week the popup was opened from. */
  weekMonday: string;
};

function parseDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function shiftDateStr(dateStr: string, days: number): string {
  const base = parseDate(dateStr);
  if (!base) return dateStr;
  base.setDate(base.getDate() + days);
  return toStr(base);
}

/** Monday-based weekday of a `YYYY-MM-DD` (0 = Mon … 6 = Sun), or -1 when it isn't a real date. */
export function weekdayOfDateStr(dateStr: string): number {
  const date = parseDate(dateStr);
  return date ? (date.getDay() + 6) % 7 : -1;
}

/** Monday of the week containing `dateStr`. */
export function mondayOfDateStr(dateStr: string): string {
  const weekday = weekdayOfDateStr(dateStr);
  return weekday < 0 ? dateStr : shiftDateStr(dateStr, -weekday);
}

export function isRealDateStr(dateStr: string): boolean {
  const date = parseDate(dateStr);
  return Boolean(date) && toStr(date!) === dateStr;
}

export function validateDraft(draft: AvailabilityDraft): string | null {
  if (draft.kinds.length === 0) return "Pick what you are available for";
  if (draft.on === "date" && !isRealDateStr(draft.date)) return "Pick a date";
  if (draft.on === "days" && draft.weekdays.length === 0) return "Pick at least one day";
  if (!(draft.endSlotExclusive > draft.startSlot)) return "The end time has to be after the start";
  if (draft.propertyIds.length === 0) return "Pick at least one house";
  return null;
}

/** Every date the draft covers (a single date, this week's days, or the next 26 weeks of them). */
export function draftDates(draft: AvailabilityDraft): string[] {
  if (draft.on === "date") return isRealDateStr(draft.date) ? [draft.date] : [];
  const weekdays = [...new Set(draft.weekdays)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
  const weeks = draft.repeat === "week" ? 1 : EVERY_WEEK_HORIZON_WEEKS;
  const dates: string[] = [];
  for (let week = 0; week < weeks; week += 1) {
    for (const weekday of weekdays) dates.push(shiftDateStr(draft.weekMonday, week * 7 + weekday));
  }
  return dates;
}

/** The `date:slot` keys Save writes (per kind, the same set). */
export function draftSlotKeys(draft: AvailabilityDraft): string[] {
  if (!(draft.endSlotExclusive > draft.startSlot)) return [];
  const keys: string[] = [];
  for (const date of draftDates(draft)) {
    for (let slot = draft.startSlot; slot < draft.endSlotExclusive; slot += 1) keys.push(`${date}:${slot}`);
  }
  return keys;
}

export type PreviewWeek = {
  /** Monday of the week shown (null = "Every week"). */
  weekOf: string | null;
  /** Monday-based indices that carry a band. */
  weekdays: number[];
  startSlot: number;
  endSlotExclusive: number;
  ok: boolean;
};

/** What the popup's small week draws: exactly the bands Save creates in that week. */
export function previewWeek(draft: AvailabilityDraft): PreviewWeek {
  const ok = draft.endSlotExclusive > draft.startSlot;
  if (draft.on === "date") {
    const real = isRealDateStr(draft.date);
    return {
      weekOf: real ? mondayOfDateStr(draft.date) : mondayOfDateStr(draft.weekMonday),
      weekdays: real ? [weekdayOfDateStr(draft.date)] : [],
      startSlot: draft.startSlot,
      endSlotExclusive: draft.endSlotExclusive,
      ok,
    };
  }
  return {
    weekOf: draft.repeat === "week" ? draft.weekMonday : null,
    weekdays: [...new Set(draft.weekdays)].sort((a, b) => a - b),
    startSlot: draft.startSlot,
    endSlotExclusive: draft.endSlotExclusive,
    ok,
  };
}

/* ---------------------------------------------------------------- slot-set operations */

export function addKeys(current: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(current);
  for (const key of keys) next.add(key);
  return next;
}

/** Remove one painted run on one date (the band that was clicked, before its replacement is written). */
export function removeRun(
  current: ReadonlySet<string>,
  dateStr: string,
  startSlot: number,
  endSlotExclusive: number,
): Set<string> {
  const next = new Set(current);
  for (let slot = startSlot; slot < endSlotExclusive; slot += 1) next.delete(`${dateStr}:${slot}`);
  return next;
}

export function weekDateStrs(weekMonday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => shiftDateStr(weekMonday, index));
}

function isSlotKeyInDates(key: string, dates: ReadonlySet<string>): boolean {
  const bare = key.startsWith("!") ? key.slice(1) : key;
  return dates.has(bare.split(":")[0] ?? "");
}

/**
 * Clear week: removes this week's windows of this kind and nothing from any
 * other week (so a window that repeats keeps repeating everywhere else). For
 * tours, when the implicit 9 to 5 default is on, the week's default windows
 * are excluded too so the cleared week stays cleared.
 */
export function clearWeek(
  current: ReadonlySet<string>,
  weekMonday: string,
  excludeDefault?: { startSlot: number; endSlotExclusive: number },
): Set<string> {
  const dates = new Set(weekDateStrs(weekMonday));
  const next = new Set<string>();
  for (const key of current) if (!isSlotKeyInDates(key, dates)) next.add(key);
  if (excludeDefault) {
    for (const date of dates) {
      for (let slot = excludeDefault.startSlot; slot < excludeDefault.endSlotExclusive; slot += 1) {
        next.add(defaultTourSlotExclusionKey(date, slot));
      }
    }
  }
  return next;
}

/**
 * Copy previous week: this week's windows become last week's, shifted seven
 * days. Cleared-day markers (a default window the manager removed) come along
 * so a day last week had cleared stays cleared this week (C2-CALA7).
 */
export function copyPreviousWeek(current: ReadonlySet<string>, weekMonday: string): Set<string> {
  const target = new Set(weekDateStrs(weekMonday));
  const previousMonday = shiftDateStr(weekMonday, -7);
  const source = new Set(weekDateStrs(previousMonday));
  const next = new Set<string>();
  for (const key of current) if (!isSlotKeyInDates(key, target)) next.add(key);
  for (const key of current) {
    if (!isSlotKeyInDates(key, source)) continue;
    const bang = key.startsWith("!");
    const bare = bang ? key.slice(1) : key;
    const [date, slot] = bare.split(":");
    if (!date || slot === undefined) continue;
    next.add(`${bang ? "!" : ""}${shiftDateStr(date, 7)}:${slot}`);
  }
  return next;
}

/**
 * A weekly window never starts in the past: when the popup was opened from a
 * week that has already gone by, "Every week" begins with the current week.
 * "This week only" and a single date stay exactly where they were put.
 */
export function normalizeDraftStart(draft: AvailabilityDraft, todayStr: string): AvailabilityDraft {
  if (draft.on !== "days" || draft.repeat !== "weekly") return draft;
  const currentMonday = mondayOfDateStr(todayStr);
  return draft.weekMonday < currentMonday ? { ...draft, weekMonday: currentMonday } : draft;
}
