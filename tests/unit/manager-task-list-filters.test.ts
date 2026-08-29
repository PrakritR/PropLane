import { describe, expect, it } from "vitest";
import {
  countTaskListFilterBuckets,
  managerTaskIsScheduled,
  taskListRowMatchesFilter,
} from "@/lib/manager-task-display";
import type { ManagerTask } from "@/lib/manager-tasks";
import type { ServiceRequest } from "@/lib/service-requests-storage";

const baseTask = (overrides: Partial<ManagerTask>): ManagerTask => ({
  id: "t1",
  title: "Task",
  completed: false,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
  ...overrides,
});

describe("managerTaskIsScheduled", () => {
  it("requires both start and end", () => {
    expect(managerTaskIsScheduled({ start: "2026-08-01T10:00:00.000Z", end: "2026-08-01T11:00:00.000Z" })).toBe(
      true,
    );
    expect(managerTaskIsScheduled({ start: "2026-08-01T10:00:00.000Z" })).toBe(false);
    expect(managerTaskIsScheduled({ dueDate: "2026-08-02T12:00:00.000Z" })).toBe(false);
  });
});

describe("taskListRowMatchesFilter", () => {
  it("routes service rows to the services pill only", () => {
    const serviceRow = {
      kind: "service" as const,
      request: { id: "s1", propertyId: "p1" } as ServiceRequest,
    };
    expect(taskListRowMatchesFilter(serviceRow, "all")).toBe(true);
    expect(taskListRowMatchesFilter(serviceRow, "services")).toBe(true);
    expect(taskListRowMatchesFilter(serviceRow, "open")).toBe(false);
  });

  it("splits scheduled vs open tasks", () => {
    const scheduled = { kind: "task" as const, task: baseTask({ id: "a", start: "a", end: "b" }) };
    const open = { kind: "task" as const, task: baseTask({ id: "b", dueDate: "2026-08-02T12:00:00.000Z" }) };
    expect(taskListRowMatchesFilter(scheduled, "scheduled")).toBe(true);
    expect(taskListRowMatchesFilter(scheduled, "open")).toBe(false);
    expect(taskListRowMatchesFilter(open, "open")).toBe(true);
    expect(taskListRowMatchesFilter(open, "scheduled")).toBe(false);
  });
});

describe("countTaskListFilterBuckets", () => {
  it("counts open, scheduled, and service orders separately", () => {
    const counts = countTaskListFilterBuckets({
      tabId: "in-progress",
      matchesProperty: () => true,
      tasks: [
        baseTask({ id: "open", dueDate: "2026-08-02T12:00:00.000Z" }),
        baseTask({ id: "sched", start: "a", end: "b" }),
      ],
      services: [{ id: "s1", propertyId: "p1", requestedAt: "2026-08-01T12:00:00.000Z" } as ServiceRequest],
    });
    expect(counts).toEqual({ all: 3, open: 1, scheduled: 1, services: 1 });
  });
});
