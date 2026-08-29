import { describe, expect, it } from "vitest";
import {
  MANAGER_TASK_PRIORITIES,
  MANAGER_TASK_URGENCIES,
  inferManagerTaskUrgency,
  normalizeManagerTasks,
  normalizeTaskPriority,
  normalizeTaskUrgency,
} from "@/lib/manager-tasks";

describe("task urgency", () => {
  it("accepts the three timings and rejects anything else", () => {
    for (const value of MANAGER_TASK_URGENCIES) {
      expect(normalizeTaskUrgency(value)).toBe(value);
    }
    expect(normalizeTaskUrgency("SCHEDULED")).toBe("scheduled");
    expect(normalizeTaskUrgency(" urgent ")).toBe("urgent");
    expect(normalizeTaskUrgency("whenever")).toBeUndefined();
    expect(normalizeTaskUrgency(null)).toBeUndefined();
    expect(normalizeTaskUrgency(3)).toBeUndefined();
  });

  it("reads a legacy row's timing off the dates it already has", () => {
    // Rows saved before the field existed must not all claim a calendar slot.
    expect(
      inferManagerTaskUrgency({ start: "2026-08-29T12:00:00Z", end: "2026-08-29T13:00:00Z" }),
    ).toBe("scheduled");
    expect(inferManagerTaskUrgency({ dueDate: "2026-08-29" })).toBe("deadline");
    expect(inferManagerTaskUrgency({})).toBe("urgent");
  });

  it("prefers an explicit timing over whatever the dates imply", () => {
    expect(
      inferManagerTaskUrgency({
        urgency: "urgent",
        start: "2026-08-29T12:00:00Z",
        end: "2026-08-29T13:00:00Z",
      }),
    ).toBe("urgent");
  });

  it("does not treat a half-scheduled row as scheduled", () => {
    // A start with no end reserves nothing, so it is a deadline at best.
    expect(inferManagerTaskUrgency({ start: "2026-08-29T12:00:00Z" })).toBe("urgent");
    expect(
      inferManagerTaskUrgency({ start: "2026-08-29T12:00:00Z", dueDate: "2026-08-30" }),
    ).toBe("deadline");
  });
});

describe("task priority", () => {
  it("accepts the three levels and rejects anything else", () => {
    for (const value of MANAGER_TASK_PRIORITIES) {
      expect(normalizeTaskPriority(value)).toBe(value);
    }
    expect(normalizeTaskPriority("HIGH")).toBe("high");
    expect(normalizeTaskPriority("critical")).toBeUndefined();
    expect(normalizeTaskPriority(undefined)).toBeUndefined();
  });

  it("stays independent of urgency", () => {
    // How soon something must happen and how much it matters are separate
    // questions; neither field may be derived from the other.
    expect(MANAGER_TASK_URGENCIES).not.toContain("high");
    expect(MANAGER_TASK_PRIORITIES).not.toContain("urgent");
  });
});

describe("stored rows", () => {
  const base = {
    id: "t1",
    title: "Room ready",
    completed: false,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };

  it("round-trips urgency and priority through the read path", () => {
    const [task] = normalizeManagerTasks([{ ...base, urgency: "deadline", priority: "high" }]);
    expect(task?.urgency).toBe("deadline");
    expect(task?.priority).toBe("high");
  });

  it("drops values it does not recognise rather than storing them", () => {
    // A bad value must not survive into the row, or the badge and the filter
    // would render something the rest of the app has no meaning for.
    const [task] = normalizeManagerTasks([{ ...base, urgency: "someday", priority: "critical" }]);
    expect(task?.urgency).toBeUndefined();
    expect(task?.priority).toBeUndefined();
  });

  it("leaves a pre-existing row untouched and still readable", () => {
    const [task] = normalizeManagerTasks([{ ...base, dueDate: "2026-08-30T23:59:00.000Z" }]);
    expect(task?.urgency).toBeUndefined();
    expect(task?.priority).toBeUndefined();
    // The list still knows how to time it, without the field being stored.
    expect(inferManagerTaskUrgency(task!)).toBe("deadline");
  });
});
