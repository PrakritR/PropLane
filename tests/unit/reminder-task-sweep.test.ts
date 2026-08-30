/**
 * Which tasks the sweep considers remindable.
 *
 * The sweep runs on every dispatcher tick, so these predicates decide how much
 * work a tick does. Getting them wrong is either a missed reminder or a query
 * per task for tasks that could never produce one.
 */
import { describe, expect, it } from "vitest";
import { remindableTasks, taskAnchorIso } from "@/lib/reminders/subjects/tasks.server";
import type { ManagerTask } from "@/lib/manager-tasks";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function task(over: Partial<ManagerTask> = {}): ManagerTask {
  return {
    id: "t-1",
    title: "Collect rent",
    completed: false,
    assignee: { type: "team", id: "u-1", name: "Ada" },
    dueDate: inHours(5),
    ...over,
  } as ManagerTask;
}

describe("taskAnchorIso", () => {
  it("prefers a scheduled start over a due date", () => {
    const t = task({ start: inHours(2), dueDate: inHours(9) });
    expect(taskAnchorIso(t)).toBe(new Date(inHours(2)).toISOString());
  });

  it("falls back to the due date for an unscheduled task", () => {
    expect(taskAnchorIso(task({ start: undefined, dueDate: inHours(3) }))).toBe(
      new Date(inHours(3)).toISOString(),
    );
  });

  it("returns null when the task is on no clock at all", () => {
    expect(taskAnchorIso(task({ start: undefined, dueDate: undefined }))).toBeNull();
    expect(taskAnchorIso(task({ start: "", dueDate: "" }))).toBeNull();
    expect(taskAnchorIso(task({ start: undefined, dueDate: "not-a-date" }))).toBeNull();
  });
});

describe("remindableTasks", () => {
  it("keeps an open, assigned, upcoming task", () => {
    expect(remindableTasks([task()], NOW).map((t) => t.id)).toEqual(["t-1"]);
  });

  it("drops a completed task", () => {
    expect(remindableTasks([task({ completed: true })], NOW)).toEqual([]);
  });

  it("drops an unassigned task — there is nobody to remind", () => {
    expect(remindableTasks([task({ assignee: undefined })], NOW)).toEqual([]);
  });

  it("drops a task already past: that is the overdue path's job, not a reminder's", () => {
    expect(remindableTasks([task({ dueDate: inHours(-2) })], NOW)).toEqual([]);
  });

  it("drops a task beyond the horizon so a tick stays bounded", () => {
    expect(remindableTasks([task({ dueDate: inHours(24 * 40) })], NOW)).toEqual([]);
  });

  it("keeps one at the horizon edge and excludes one just past it", () => {
    const inside = task({ id: "in", start: undefined, dueDate: inHours(24 * 31 - 1) });
    const outside = task({ id: "out", start: undefined, dueDate: inHours(24 * 31 + 1) });
    expect(remindableTasks([inside, outside], NOW).map((t) => t.id)).toEqual(["in"]);
  });

  it("filters a mixed list down to only the ones worth a query", () => {
    const list = [
      task({ id: "keep-a" }),
      task({ id: "done", completed: true }),
      task({ id: "no-assignee", assignee: undefined }),
      task({ id: "past", dueDate: inHours(-1) }),
      task({ id: "keep-b", start: inHours(1) }),
      task({ id: "no-clock", start: undefined, dueDate: undefined }),
    ];
    expect(remindableTasks(list, NOW).map((t) => t.id)).toEqual(["keep-a", "keep-b"]);
  });
});
