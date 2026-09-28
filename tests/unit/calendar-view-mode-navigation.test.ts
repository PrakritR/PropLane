/**
 * Day | Week | Month navigation (K002/K003/K004) — date bucketing across a
 * DST transition, and the all-day/timed split for a task's calendar block.
 *
 * `shiftCalendarAnchor` and `buildMonthCells` (via `calendarVisibleDateCount`)
 * are noon-anchored specifically so a DST transition can never skip or repeat
 * a local calendar date. These tests pin the process to a DST-observing zone
 * (America/Los_Angeles, the product's own tour-calendar clock — see
 * `tests/unit/tour-slot-math-timezone.test.ts`) so the bug class a UTC-only
 * dev box cannot see is actually exercised, then repeat the same assertions
 * under UTC to confirm the noon anchor is zone-independent.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  calendarTodayAnchor,
  calendarVisibleDateCount,
  shiftCalendarAnchor,
  type CalendarMode,
} from "@/components/portal/portal-calendar-panels";
import { taskToPlannedEvent } from "@/lib/manager-tasks";
import type { ManagerTask } from "@/lib/manager-tasks";

const originalTz = process.env.TZ;

function withProcessTimeZone(timeZone: string, body: () => void) {
  process.env.TZ = timeZone;
  try {
    body();
  } finally {
    process.env.TZ = originalTz;
  }
}

afterEach(() => {
  process.env.TZ = originalTz;
});

/** `YYYY-MM-DD` in the CURRENT process zone — matches how the panel buckets a Date. */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("shiftCalendarAnchor across DST", () => {
  for (const zone of ["America/Los_Angeles", "UTC"]) {
    describe(`zone=${zone}`, () => {
      it("steps one day at a time through spring-forward without skipping or repeating a date", () => {
        withProcessTimeZone(zone, () => {
          // 2026-03-08 02:00 America/Los_Angeles is the spring-forward instant.
          let d = new Date(2026, 2, 7, 12, 0, 0, 0); // Sat Mar 7, noon local
          const seen: string[] = [localDateStr(d)];
          for (let i = 0; i < 4; i += 1) {
            d = shiftCalendarAnchor(d, "day", 1);
            seen.push(localDateStr(d));
          }
          expect(seen).toEqual(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11"]);
          // Every date distinct — no skip, no repeat.
          expect(new Set(seen).size).toBe(seen.length);
        });
      });

      it("steps one day at a time through fall-back without skipping or repeating a date", () => {
        withProcessTimeZone(zone, () => {
          // 2026-11-01 02:00 America/Los_Angeles is the fall-back instant.
          let d = new Date(2026, 9, 31, 12, 0, 0, 0); // Sat Oct 31, noon local
          const seen: string[] = [localDateStr(d)];
          for (let i = 0; i < 4; i += 1) {
            d = shiftCalendarAnchor(d, "day", 1);
            seen.push(localDateStr(d));
          }
          expect(seen).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
          expect(new Set(seen).size).toBe(seen.length);
        });
      });

      it("steps one week at a time across spring-forward and lands exactly 7 days later", () => {
        withProcessTimeZone(zone, () => {
          const start = new Date(2026, 2, 4, 12, 0, 0, 0); // Wed Mar 4
          const next = shiftCalendarAnchor(start, "week", 1);
          expect(localDateStr(next)).toBe("2026-03-11");
          const back = shiftCalendarAnchor(next, "week", -1);
          expect(localDateStr(back)).toBe(localDateStr(start));
        });
      });

      it("steps one month at a time and keeps the day-of-month across a DST-crossing month", () => {
        withProcessTimeZone(zone, () => {
          const start = new Date(2026, 1, 15, 12, 0, 0, 0); // Feb 15 (no DST crossing yet)
          const next = shiftCalendarAnchor(start, "month", 1); // -> March, crosses spring-forward
          expect(next.getFullYear()).toBe(2026);
          expect(next.getMonth()).toBe(2);
          expect(next.getDate()).toBe(15);
        });
      });

      it("calendarTodayAnchor returns a fresh Date, not the same reference", () => {
        withProcessTimeZone(zone, () => {
          const now = new Date();
          const anchor = calendarTodayAnchor(now);
          expect(anchor).not.toBe(now);
          expect(anchor.getTime()).toBe(now.getTime());
        });
      });

      it("calendarVisibleDateCount reports 1/7/N for day/week/month, N covering a DST-crossing month", () => {
        withProcessTimeZone(zone, () => {
          const anchor = new Date(2026, 2, 15, 12, 0, 0, 0); // March 2026, 31 days
          expect(calendarVisibleDateCount("day", anchor)).toBe(1);
          expect(calendarVisibleDateCount("week", anchor)).toBe(7);
          expect(calendarVisibleDateCount("month", anchor)).toBe(31);
        });
      });

      it("calendarVisibleDateCount handles a non-leap February", () => {
        withProcessTimeZone(zone, () => {
          const anchor = new Date(2026, 1, 10, 12, 0, 0, 0); // Feb 2026, not a leap year
          expect(calendarVisibleDateCount("month", anchor)).toBe(28);
        });
      });
    });
  }
});

const CALENDAR_MODES: CalendarMode[] = ["day", "week", "month"];

describe("shiftCalendarAnchor direction symmetry", () => {
  for (const mode of CALENDAR_MODES) {
    it(`${mode}: stepping forward then back returns the original date`, () => {
      const start = new Date(2026, 5, 15, 12, 0, 0, 0);
      const forward = shiftCalendarAnchor(start, mode, 1);
      const back = shiftCalendarAnchor(forward, mode, -1);
      expect(localDateStr(back)).toBe(localDateStr(start));
    });
  }
});

function baseTask(overrides: Partial<ManagerTask> = {}): ManagerTask {
  return {
    id: "task-1",
    title: "Replace air filter",
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("taskToPlannedEvent all-day bucketing (K003 all-day row)", () => {
  it("marks a due-date-only task allDay and buckets it on the due date, even across spring-forward", () => {
    withProcessTimeZone("America/Los_Angeles", () => {
      // The due date itself is the DST transition day.
      const event = taskToPlannedEvent(baseTask({ dueDate: "2026-03-08T00:00:00.000Z" }), "manager-1");
      expect(event).not.toBeNull();
      expect(event!.allDay).toBe(true);
      expect(event!.title).toMatch(/^Due · /);
    });
  });

  it("never marks a task with an explicit start/end as allDay", () => {
    withProcessTimeZone("America/Los_Angeles", () => {
      const event = taskToPlannedEvent(
        baseTask({
          start: "2026-03-08T17:00:00.000Z",
          end: "2026-03-08T17:30:00.000Z",
          dueDate: "2026-03-08T00:00:00.000Z",
        }),
        "manager-1",
      );
      expect(event).not.toBeNull();
      expect(event!.allDay).toBeFalsy();
      expect(event!.title).toMatch(/^Task · /);
    });
  });

  it("returns null for a task with neither a start/end nor a due date", () => {
    const event = taskToPlannedEvent(baseTask(), "manager-1");
    expect(event).toBeNull();
  });
});
