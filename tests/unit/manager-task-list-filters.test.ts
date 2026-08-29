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
  it("routes service rows to the service orders pill only", () => {
    const serviceRow = {
      kind: "service" as const,
      request: { id: "s1", propertyId: "p1" } as ServiceRequest,
    };
    expect(taskListRowMatchesFilter(serviceRow, "all")).toBe(true);
    expect(taskListRowMatchesFilter(serviceRow, "service_orders")).toBe(true);
    expect(taskListRowMatchesFilter(serviceRow, "tours")).toBe(false);
  });

  it("splits tasks by type", () => {
    const tour = { kind: "task" as const, task: baseTask({ id: "a", taskType: "tour" }) };
    const house = {
      kind: "task" as const,
      task: baseTask({ id: "b", taskType: "house", propertyId: "p1", roomLabel: "Room A" }),
    };
    const general = { kind: "task" as const, task: baseTask({ id: "c", taskType: "general" }) };
    expect(taskListRowMatchesFilter(tour, "tours")).toBe(true);
    expect(taskListRowMatchesFilter(tour, "house_tasks")).toBe(false);
    expect(taskListRowMatchesFilter(house, "house_tasks")).toBe(true);
    expect(taskListRowMatchesFilter(general, "general_tasks")).toBe(true);
    expect(taskListRowMatchesFilter(general, "tours")).toBe(false);
  });
});

describe("countTaskListFilterBuckets", () => {
  it("counts tours, house tasks, general tasks, and service orders separately", () => {
    const counts = countTaskListFilterBuckets({
      tabId: "in-progress",
      matchesProperty: () => true,
      tasks: [
        baseTask({ id: "general", taskType: "general" }),
        baseTask({ id: "house", taskType: "house", propertyId: "p1", roomLabel: "A" }),
        baseTask({ id: "tour", taskType: "tour" }),
      ],
      services: [{ id: "s1", propertyId: "p1", requestedAt: "2026-08-01T12:00:00.000Z" } as ServiceRequest],
    });
    expect(counts).toEqual({
      all: 4,
      service_orders: 1,
      tours: 1,
      general_tasks: 1,
      house_tasks: 1,
    });
  });
});
