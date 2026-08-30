import { describe, expect, it } from "vitest";
import { isManagerTaskLate, managerTaskDueInstant } from "@/lib/manager-task-display";
import { buildManagerTaskReminderPreview } from "@/lib/manager-task-reminder";
import type { ManagerTask } from "@/lib/manager-tasks";

const baseTask = (overrides: Partial<ManagerTask>): ManagerTask => ({
  id: "t1",
  title: "Check in",
  completed: false,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  assignee: { type: "team", id: "mgr-1", name: "Alex" },
  ...overrides,
});

describe("managerTaskDueInstant", () => {
  it("uses scheduled end time when both start and end exist", () => {
    const end = "2026-08-28T17:00:00.000Z";
    expect(
      managerTaskDueInstant({
        start: "2026-08-28T15:00:00.000Z",
        end,
        dueDate: "2026-08-30T12:00:00.000Z",
      }),
    ).toBe(Date.parse(end));
  });

  it("uses dueDate for deadline tasks", () => {
    const dueDate = "2026-08-30T23:59:00.000Z";
    expect(managerTaskDueInstant({ dueDate })).toBe(Date.parse(dueDate));
  });
});

describe("isManagerTaskLate", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");

  it("marks incomplete tasks past their end as late", () => {
    expect(
      isManagerTaskLate(
        baseTask({
          start: "2026-08-28T15:00:00.000Z",
          end: "2026-08-28T17:00:00.000Z",
        }),
        now,
      ),
    ).toBe(true);
  });

  it("ignores completed tasks and tasks with no timing", () => {
    expect(
      isManagerTaskLate(
        baseTask({
          completed: true,
          end: "2026-08-28T17:00:00.000Z",
          start: "2026-08-28T15:00:00.000Z",
        }),
        now,
      ),
    ).toBe(false);
    expect(isManagerTaskLate(baseTask({ urgency: "urgent" }), now)).toBe(false);
  });
});

describe("buildManagerTaskReminderPreview", () => {
  it("tailors tour reminders and marks overdue copy", () => {
    const preview = buildManagerTaskReminderPreview({
      task: baseTask({
        taskType: "tour",
        title: "Tour · Jamie",
        start: "2026-08-28T15:00:00.000Z",
        end: "2026-08-28T16:00:00.000Z",
      }),
      late: true,
    });
    expect(preview.subject).toContain("Overdue tour");
    expect(preview.body).toContain("tour slot has passed");
    expect(preview.body).toContain("Type: Tour");
  });

  it("tailors work order reminders", () => {
    const preview = buildManagerTaskReminderPreview({
      task: baseTask({
        taskType: "work_order",
        title: "Service · Leaky faucet",
      }),
    });
    expect(preview.subject).toContain("Service reminder");
    expect(preview.body).toContain("service request");
  });
});
