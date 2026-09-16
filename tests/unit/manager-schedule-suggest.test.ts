import { describe, expect, it } from "vitest";
import { tourCalendarDateStr, TOUR_CALENDAR_TIME_ZONE, zonedWallTimeMs } from "@/lib/tour-slot-math";
import {
  hasFutureAvailability,
  listProplanePickCandidates,
  suggestManagerTime,
  type SuggestBusyWindow,
} from "@/lib/manager-schedule-suggest";

// Mon Sep 14 2026, 10:00 Pacific (PDT, UTC-7).
const NOW = new Date("2026-09-14T17:00:00Z");

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function pacificWeekday(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

function pacificIso(dateStr: string, minute: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(zonedWallTimeMs(year!, month!, day!, minute, TOUR_CALENDAR_TIME_ZONE)).toISOString();
}

function pacificMinuteOfDay(iso: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TOUR_CALENDAR_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(iso))) map[part.type] = part.value;
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  return hour * 60 + Number(map.minute);
}

function pacificDateOf(iso: string): string {
  return tourCalendarDateStr(new Date(iso).getTime(), TOUR_CALENDAR_TIME_ZONE);
}

const TOMORROW = addDays(tourCalendarDateStr(NOW.getTime(), TOUR_CALENDAR_TIME_ZONE), 1); // 2026-09-15, Tuesday

describe("hasFutureAvailability", () => {
  it("is false for an empty set and true once a key names tomorrow or later", () => {
    expect(hasFutureAvailability([], NOW)).toBe(false);
    expect(hasFutureAvailability([`${TOMORROW}:18`], NOW)).toBe(true);
    const today = tourCalendarDateStr(NOW.getTime(), TOUR_CALENDAR_TIME_ZONE);
    expect(hasFutureAvailability([`${today}:40`], NOW)).toBe(false);
  });
});

describe("suggestManagerTime — availability wins", () => {
  it("prefers a painted availability slot over a PropLane pick", () => {
    const result = suggestManagerTime({
      availabilitySlotKeys: [`${TOMORROW}:18`, `${TOMORROW}:19`], // 9:00-10:00 Pacific
      busy: [],
      seed: "seed-a",
      now: NOW,
    });
    expect(result?.source).toBe("availability");
    expect(result?.iso).toBe(pacificIso(TOMORROW, 9 * 60));
  });

  it("a busy 9-10 window pushes the suggestion to 10:00", () => {
    const busy: SuggestBusyWindow[] = [{ startIso: pacificIso(TOMORROW, 9 * 60), endIso: pacificIso(TOMORROW, 10 * 60) }];
    const result = suggestManagerTime({
      availabilitySlotKeys: [`${TOMORROW}:18`, `${TOMORROW}:19`, `${TOMORROW}:20`, `${TOMORROW}:21`], // 9:00-11:00
      busy,
      seed: "seed-b",
      now: NOW,
    });
    expect(result?.source).toBe("availability");
    expect(result?.iso).toBe(pacificIso(TOMORROW, 10 * 60));
  });

  it("a 60-minute duration skips a lone 30-minute window for the next window that fits", () => {
    const result = suggestManagerTime({
      availabilitySlotKeys: [`${TOMORROW}:18`, `${TOMORROW}:22`, `${TOMORROW}:23`], // 9:00-9:30, then 11:00-12:00
      busy: [],
      durationMinutes: 60,
      seed: "seed-c",
      now: NOW,
    });
    expect(result?.source).toBe("availability");
    expect(result?.iso).toBe(pacificIso(TOMORROW, 11 * 60));
  });

  it("`after` advances the suggestion forward", () => {
    const availabilitySlotKeys = Array.from({ length: 16 }, (_, i) => `${TOMORROW}:${18 + i}`); // 9:00-17:00
    const first = suggestManagerTime({ availabilitySlotKeys, busy: [], seed: "seed-d", now: NOW });
    expect(first?.iso).toBe(pacificIso(TOMORROW, 9 * 60));

    const second = suggestManagerTime({
      availabilitySlotKeys,
      busy: [],
      seed: "seed-d",
      now: NOW,
      after: first?.iso,
    });
    expect(second?.iso).toBe(pacificIso(TOMORROW, 9 * 60 + 30));
    expect(second!.iso > first!.iso).toBe(true);
  });

  it("returns null when availability exists but every slot is busy, rather than falling back to a pick", () => {
    const busy: SuggestBusyWindow[] = [{ startIso: pacificIso(TOMORROW, 9 * 60), endIso: pacificIso(TOMORROW, 10 * 60) }];
    const result = suggestManagerTime({
      availabilitySlotKeys: [`${TOMORROW}:18`, `${TOMORROW}:19`], // exactly the busy 9:00-10:00 window
      busy,
      seed: "seed-e",
      now: NOW,
    });
    expect(result).toBeNull();
  });
});

describe("suggestManagerTime — PropLane pick", () => {
  it("picks a weekday time between 9 and 5 Pacific, identical across two calls with the same seed", () => {
    const first = suggestManagerTime({ availabilitySlotKeys: [], busy: [], seed: "same-seed", now: NOW });
    const second = suggestManagerTime({ availabilitySlotKeys: [], busy: [], seed: "same-seed", now: NOW });
    expect(first?.source).toBe("proplane-pick");
    expect(first?.iso).toBe(second?.iso);
    const weekday = pacificWeekday(pacificDateOf(first!.iso));
    expect(weekday).toBeGreaterThanOrEqual(1);
    expect(weekday).toBeLessThanOrEqual(5);
    const minute = pacificMinuteOfDay(first!.iso);
    expect(minute).toBeGreaterThanOrEqual(9 * 60);
    expect(minute).toBeLessThan(17 * 60);
  });

  it("different seeds may choose a different candidate", () => {
    const candidates = listProplanePickCandidates({ busy: [], now: NOW });
    const results = new Set(
      ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"].map(
        (seed) => suggestManagerTime({ availabilitySlotKeys: [], busy: [], seed, now: NOW })!.iso,
      ),
    );
    for (const iso of results) expect(candidates).toContain(iso);
    expect(results.size).toBeGreaterThan(1);
  });

  it("never lands a candidate on a Saturday or Sunday", () => {
    const candidates = listProplanePickCandidates({ busy: [], now: NOW });
    expect(candidates.length).toBeGreaterThan(0);
    for (const iso of candidates) {
      const weekday = pacificWeekday(pacificDateOf(iso));
      expect(weekday).not.toBe(0);
      expect(weekday).not.toBe(6);
    }
  });

  it("returns null when the whole pick horizon is busy", () => {
    const busy: SuggestBusyWindow[] = [];
    const today = tourCalendarDateStr(NOW.getTime(), TOUR_CALENDAR_TIME_ZONE);
    for (let i = 1; i <= 20; i += 1) {
      const dateStr = addDays(today, i);
      busy.push({ startIso: pacificIso(dateStr, 0), endIso: pacificIso(dateStr, 24 * 60) });
    }
    expect(listProplanePickCandidates({ busy, now: NOW })).toEqual([]);
    const result = suggestManagerTime({ availabilitySlotKeys: [], busy, seed: "seed-f", now: NOW });
    expect(result).toBeNull();
  });
});
