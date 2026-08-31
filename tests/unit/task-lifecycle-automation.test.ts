/**
 * Lifecycle task rules.
 *
 * The load-bearing part is the anchor: a response deadline counts FORWARD from
 * when something arrived, a preparation deadline counts BACKWARD from a known
 * event. Getting that backwards produces a task due at the wrong end of the
 * journey, which is worse than no task at all.
 */
import { describe, expect, it } from "vitest";
import {
  DAY,
  DEFAULT_LIFECYCLE_AUTOMATION,
  HOUR,
  LIFECYCLE_TASK_KEYS,
  MAX_OFFSET_MINUTES,
  MIN_OFFSET_MINUTES,
  clampOffsetMinutes,
  describeLifecycleRule,
  formatOffset,
  lifecycleDueDate,
  lifecycleKeysForSection,
  normalizeLifecycleAutomation,
} from "@/lib/task-lifecycle-automation";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe("offsets are one unit with real bounds", () => {
  it("clamps below the floor and above the 30-day ceiling", () => {
    expect(clampOffsetMinutes(1)).toBe(MIN_OFFSET_MINUTES);
    expect(clampOffsetMinutes(-90)).toBe(MIN_OFFSET_MINUTES);
    expect(clampOffsetMinutes(999_999)).toBe(MAX_OFFSET_MINUTES);
    expect(clampOffsetMinutes(Number.NaN)).toBe(MIN_OFFSET_MINUTES);
  });

  it("reads back the way a person says it", () => {
    expect(formatOffset(30)).toBe("30 minutes");
    expect(formatOffset(HOUR)).toBe("1 hour");
    expect(formatOffset(3 * HOUR)).toBe("3 hours");
    expect(formatOffset(DAY)).toBe("1 day");
    expect(formatOffset(2 * DAY)).toBe("2 days");
  });
});

describe("normalize", () => {
  it("returns defaults for absent or junk input", () => {
    for (const input of [undefined, null, 7, "x", []]) {
      expect(normalizeLifecycleAutomation(input)).toEqual(DEFAULT_LIFECYCLE_AUTOMATION);
    }
  });

  it("carries a manager's LEGACY day-granularity choice instead of reverting it", () => {
    // The old application automation stored whole days. Dropping it would
    // silently reset a deadline someone deliberately set.
    const out = normalizeLifecycleAutomation({ review_application: { daysAfterTrigger: 4 } });
    expect(out.review_application.offsetMinutes).toBe(4 * DAY);
  });

  it("prefers the new field when both are present", () => {
    const out = normalizeLifecycleAutomation({
      review_application: { daysAfterTrigger: 9, offsetMinutes: 2 * HOUR },
    });
    expect(out.review_application.offsetMinutes).toBe(2 * HOUR);
  });

  it("keeps one stored rule and defaults its neighbours", () => {
    const out = normalizeLifecycleAutomation({ approve_tour_request: { enabled: false } });
    expect(out.approve_tour_request.enabled).toBe(false);
    expect(out.prepare_for_tour).toEqual(DEFAULT_LIFECYCLE_AUTOMATION.prepare_for_tour);
  });

  it("treats a blank assignee as the owner rather than an empty id", () => {
    const out = normalizeLifecycleAutomation({ collect_rent: { defaultAssigneeUserId: "   " } });
    expect(out.collect_rent.defaultAssigneeUserId).toBeNull();
  });
});

describe("lifecycleDueDate — the anchor decides the direction", () => {
  it("counts FORWARD from the trigger for a response deadline", () => {
    // "Approve a tour request within 1 hour of it arriving."
    const due = lifecycleDueDate(
      "approve_tour_request",
      { enabled: true, offsetMinutes: HOUR, defaultAssigneeUserId: null, sendEmailReminder: true },
      { triggeredAt: NOW },
      NOW,
    );
    expect(due?.toISOString()).toBe(at(1).toISOString());
  });

  it("counts BACKWARD from the event for a preparation deadline", () => {
    // "Be ready 3 hours before a tour that starts in 8."
    const due = lifecycleDueDate(
      "prepare_for_tour",
      { enabled: true, offsetMinutes: 3 * HOUR, defaultAssigneeUserId: null, sendEmailReminder: true },
      { eventAt: at(8) },
      NOW,
    );
    expect(due?.toISOString()).toBe(at(5).toISOString());
  });

  it("drops a preparation deadline that would already be past", () => {
    // A tour in 1 hour cannot have a 3-hour-ahead prep task; a task due before
    // it was created is noise, not a deadline.
    const due = lifecycleDueDate(
      "prepare_for_tour",
      { enabled: true, offsetMinutes: 3 * HOUR, defaultAssigneeUserId: null, sendEmailReminder: true },
      { eventAt: at(1) },
      NOW,
    );
    expect(due).toBeNull();
  });

  it("returns null with no event time to count back from", () => {
    const cfg = { enabled: true, offsetMinutes: HOUR, defaultAssigneeUserId: null, sendEmailReminder: true };
    expect(lifecycleDueDate("prepare_for_tour", cfg, {}, NOW)).toBeNull();
    expect(lifecycleDueDate("prepare_for_tour", cfg, { eventAt: null }, NOW)).toBeNull();
  });

  it("returns null for a disabled rule regardless of anchor", () => {
    const off = { enabled: false, offsetMinutes: HOUR, defaultAssigneeUserId: null, sendEmailReminder: true };
    expect(lifecycleDueDate("approve_tour_request", off, { triggeredAt: NOW }, NOW)).toBeNull();
    expect(lifecycleDueDate("prepare_for_tour", off, { eventAt: at(8) }, NOW)).toBeNull();
  });

  it("falls back to now when a response deadline has no explicit trigger time", () => {
    const due = lifecycleDueDate(
      "review_application",
      { enabled: true, offsetMinutes: DAY, defaultAssigneeUserId: null, sendEmailReminder: true },
      {},
      NOW,
    );
    expect(due?.toISOString()).toBe(at(24).toISOString());
  });
});

describe("settings copy", () => {
  it("says before or after to match the anchor", () => {
    expect(
      describeLifecycleRule("approve_tour_request", DEFAULT_LIFECYCLE_AUTOMATION.approve_tour_request),
    ).toBe("Due 1 hour after a tour is requested");
    expect(describeLifecycleRule("prepare_for_tour", DEFAULT_LIFECYCLE_AUTOMATION.prepare_for_tour)).toBe(
      "Due 3 hours before the tour starts",
    );
  });

  it("reads Off when disabled", () => {
    expect(
      describeLifecycleRule("collect_rent", { ...DEFAULT_LIFECYCLE_AUTOMATION.collect_rent, enabled: false }),
    ).toBe("Off");
  });
});

describe("sections cover every rule exactly once", () => {
  it("partitions the keys", () => {
    const grouped = (["tours", "applications", "leases", "payments"] as const).flatMap(lifecycleKeysForSection);
    expect([...grouped].sort()).toEqual([...LIFECYCLE_TASK_KEYS].sort());
    expect(new Set(grouped).size).toBe(LIFECYCLE_TASK_KEYS.length);
  });

  it("puts both tour rules under Tours", () => {
    expect(lifecycleKeysForSection("tours")).toEqual(["approve_tour_request", "prepare_for_tour"]);
  });
});
