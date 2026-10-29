/**
 * When each preset fires, as pure date logic over plain subjects. The sweep loads the subjects
 * (`sources.server.ts`) and asks these functions what is due right now; nothing here reads a clock
 * or a database, so every cadence is a one-line test.
 *
 * Every moment carries its idempotency key. A preset fires once per key however many ticks see it.
 */
import { houseInfoQuietWindow, type HouseInfoV1, getHouseInfoValue } from "@/lib/house-info";
import type { AutomationPresetId } from "./presets";

/** A resident with a fully signed lease: the subject of every one-to-one preset and the house roster. */
export type LeaseSubject = {
  leaseId: string;
  ownerUserId: string;
  workspaceId: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string | null;
  residentName: string;
  firstName: string;
  residentUserId: string | null;
  residentEmail: string;
  /** Ten digits, only when the account's phone is VERIFIED. Null = never texted. */
  phoneKey: string | null;
  /** YYYY-MM-DD, Pacific wall date the lease was fully signed. */
  signedKey: string | null;
  /** YYYY-MM-DD */
  moveIn: string | null;
  /** YYYY-MM-DD, only an explicit move-out date. */
  moveOut: string | null;
};

export type HouseSubject = {
  ownerUserId: string;
  workspaceId: string;
  propertyId: string;
  propertyLabel: string;
  houseInfo: HouseInfoV1;
  /** Each room's door code: a secret that lives on the room, not in `houseInfo`. */
  roomSecrets: readonly string[];
};

export type ResidentMoment = {
  preset: AutomationPresetId;
  key: string;
  subject: LeaseSubject;
};

export type HouseMoment = {
  preset: AutomationPresetId;
  key: string;
  house: HouseSubject;
  /** The sentence a `house_reminders` text carries. */
  reminder?: string;
};

export function dateKeyToUtcMs(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days from `fromKey` to `toKey` (positive = `toKey` is later). Null on a bad key. */
export function daysBetweenKeys(fromKey: string, toKey: string): number | null {
  const a = dateKeyToUtcMs(fromKey);
  const b = dateKeyToUtcMs(toKey);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

export function addDaysToKey(key: string, days: number): string {
  const ms = dateKeyToUtcMs(key);
  if (ms === null) return key;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function weekdayOfKey(key: string): (typeof WEEKDAYS)[number] | null {
  const ms = dateKeyToUtcMs(key);
  return ms === null ? null : WEEKDAYS[new Date(ms).getUTCDay()]!;
}

/** The resident-facing presets due for one lease right now. */
export function residentMoments(subject: LeaseSubject, todayKey: string): ResidentMoment[] {
  const out: ResidentMoment[] = [];
  if (subject.signedKey) {
    const age = daysBetweenKeys(subject.signedKey, todayKey);
    // A week's grace so a missed tick or a mode flipped on the same day still sends; older leases
    // are history, never texted "welcome" months later when a manager turns the preset on.
    if (age !== null && age >= 0 && age <= 7) out.push({ preset: "welcome", key: `welcome:${subject.leaseId}`, subject });
  }
  if (subject.moveIn) {
    const until = daysBetweenKeys(todayKey, subject.moveIn);
    if (until !== null && until >= 0 && until <= 3) {
      out.push({ preset: "move_in_3d", key: `move_in_3d:${subject.leaseId}`, subject });
    }
  }
  return out;
}

export type PacificClock = { todayKey: string; hour: number; dayOfMonth: number };

/** Posts to a house group wait for a civil hour: 9 am to 9 pm Pacific. */
export function isGroupPostHour(hour: number): boolean {
  return hour >= 9 && hour < 21;
}

/** Trash night reminders go out in the evening before pickup, 5 pm to 9 pm. */
export function isEveningReminderHour(hour: number): boolean {
  return hour >= 17 && hour < 21;
}

/**
 * The house-wide presets due for one house right now. `rentDueToday` is whether any rent charge in
 * the house is due today (the text names no one and no amount). Quiet hours: nothing before 9 am,
 * and nothing inside the house's own quiet window either (a house that keeps 8 pm quiet hours
 * hears no reminder after it).
 */
export function houseMoments(input: {
  house: HouseSubject;
  roster: readonly LeaseSubject[];
  rentDueToday: boolean;
  clock: PacificClock;
}): HouseMoment[] {
  const { house, roster, rentDueToday, clock } = input;
  const out: HouseMoment[] = [];
  const quiet = houseInfoQuietWindow(house.houseInfo);
  const hourQuiet = quiet ? withinQuietWindow(clock.hour, quiet) : false;
  const civil = isGroupPostHour(clock.hour) && !hourQuiet;
  if (!civil) return out;

  if (roster.some((s) => s.moveIn === clock.todayKey)) {
    out.push({ preset: "move_in_day", key: `move_in_day:${house.propertyId}:${clock.todayKey}`, house });
  }
  if (rentDueToday) {
    out.push({ preset: "rent_due_day", key: `rent_due_day:${house.propertyId}:${clock.todayKey}`, house });
  }
  if (roster.some((s) => s.moveOut === clock.todayKey)) {
    out.push({ preset: "move_out", key: `move_out:${house.propertyId}:${clock.todayKey}`, house });
  }

  if (isEveningReminderHour(clock.hour)) {
    const tomorrow = addDaysToKey(clock.todayKey, 1);
    const weekday = weekdayOfKey(tomorrow);
    const trash = getHouseInfoValue(house.houseInfo, "trash", "day");
    const recycling = getHouseInfoValue(house.houseInfo, "trash", "recycling");
    const trashTomorrow = Boolean(weekday && trash === weekday);
    const recyclingTomorrow = Boolean(weekday && recycling === weekday);
    if (trashTomorrow || recyclingTomorrow) {
      const what = trashTomorrow && recyclingTomorrow ? "Trash and recycling" : trashTomorrow ? "Trash" : "Recycling";
      out.push({
        preset: "house_reminders",
        key: `house_pickup:${house.propertyId}:${tomorrow}`,
        house,
        reminder: `${what} pickup is tomorrow. Please put the bins out tonight.`,
      });
    }
  }
  const cadence = getHouseInfoValue(house.houseInfo, "trash", "cleaningCadence");
  if (cadence === "Monthly" && clock.dayOfMonth === 1) {
    out.push({
      preset: "house_reminders",
      key: `house_cleaning:${house.propertyId}:${clock.todayKey.slice(0, 7)}`,
      house,
      reminder: "Monthly cleaning is this week. Please keep common areas clear.",
    });
  }
  return out;
}

/** Is `hour` inside a from-to window that may wrap midnight ("22:00" to "08:00")? */
export function withinQuietWindow(hour: number, window: { from: string; to: string }): boolean {
  const from = Number(window.from.split(":")[0]);
  const to = Number(window.to.split(":")[0]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** A pretend-free "first name": the first word of a full name, title-cased, or "there". */
export function firstNameOf(fullName: string): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first || /[@\d]/.test(first)) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "2026-11-01" -> "Nov 1" (no year; a text reads naturally). */
export function shortDateLabel(key: string): string {
  const ms = dateKeyToUtcMs(key);
  if (ms === null) return "";
  return new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/**
 * A scheduled service that applies to the whole house rather than one person's room. The row's
 * `unit` is the room a resident filed from; a common area, the whole house or no room at all is
 * house-wide. Deliberately narrow: when in doubt the visit is one resident's, and stays 1:1.
 */
export function workOrderIsHouseWide(row: { unit?: unknown; title?: unknown }): boolean {
  const unit = String(row.unit ?? "").trim().toLowerCase();
  if (!unit) return false;
  return /\b(common|whole house|entire house|house[- ]wide|shared|exterior|yard|roof|basement|garage|hall(way)?|kitchen|laundry|all rooms)\b/.test(unit);
}
