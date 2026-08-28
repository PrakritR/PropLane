import { describe, expect, it } from "vitest";
import { normalizeManagerTasks, type ManagerTask } from "@/lib/manager-tasks";
import { dueDateFromDaysAfter, normalizeTaskAutomation } from "@/lib/task-automation-preferences";

describe("manager task due dates", () => {
  it("normalizes dueDate and template metadata on tasks", () => {
    const [task] = normalizeManagerTasks([
      {
        id: "t1",
        title: "Review application",
        dueDate: "2026-08-30T23:59:00.000Z",
        templateKey: "review_application",
        sourceId: "app-1",
        completed: false,
        assignee: { type: "team", id: "mgr-1", name: "Alex" },
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ]);
    expect(task?.dueDate).toBe("2026-08-30T23:59:00.000Z");
    expect(task?.templateKey).toBe("review_application");
    expect(task?.sourceId).toBe("app-1");
  });

  it("computes due dates N days after trigger", () => {
    const due = dueDateFromDaysAfter("2026-08-28T12:00:00.000Z", 2);
    const dueDay = new Date(due).getDate();
    expect(dueDay).toBe(30);
  });

  it("defaults task automation templates to enabled", () => {
    const prefs = normalizeTaskAutomation(undefined);
    expect(prefs.review_application.enabled).toBe(true);
    expect(prefs.review_application.daysAfterTrigger).toBe(2);
  });
});

describe("normalizeManagerTasks", () => {
  it("accepts task arrays from storage", () => {
    const rows = normalizeManagerTasks([
      {
        id: "a",
        title: "Collect rent",
        completed: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies ManagerTask,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Collect rent");
  });
});
