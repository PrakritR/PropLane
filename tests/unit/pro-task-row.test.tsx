// @vitest-environment jsdom
//
// The shared task row: due state from wall dates, a chip only when it is
// today or overdue, every priority named, and the phone line that hides the
// viewer's own avatar.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskTableRow, taskDueState } from "@/components/portal/pro-task-row";
import type { ManagerTask } from "@/lib/manager-tasks";

vi.mock("@/components/portal/portal-inbox-ui", () => ({
  InboxAvatar: ({ name }: { name: string }) => <span data-testid="avatar">{name}</span>,
}));

// Fri Sep 11 2026, 19:30 local.
const NOW = new Date(2026, 8, 11, 19, 30).getTime();

function task(over: Partial<ManagerTask>): ManagerTask {
  return { id: "t1", title: "Fix the porch light", completed: false, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over } as ManagerTask;
}

afterEach(() => cleanup());

describe("taskDueState", () => {
  it("reads bare dates as the manager's own day", () => {
    expect(taskDueState(task({ dueDate: "2026-09-10" }), NOW)).toBe("overdue");
    expect(taskDueState(task({ dueDate: "2026-09-11" }), NOW)).toBe("today");
    expect(taskDueState(task({ dueDate: "2026-09-15" }), NOW)).toBe("soon");
    expect(taskDueState(task({ dueDate: "2026-10-30" }), NOW)).toBe("later");
    expect(taskDueState(task({}), NOW)).toBe("none");
    expect(taskDueState(task({ dueDate: "2026-09-01", completed: true }), NOW)).toBe("done");
  });
});

describe("TaskTableRow", () => {
  it("chips an overdue task with how late it is, and names Normal priority", () => {
    render(
      <TaskTableRow task={task({ dueDate: "2026-09-08" })} propertyLabel="Ash Flats 6" viewerUserId="u1" nowMs={NOW} onOpen={() => {}} />,
    );
    expect(screen.getByText("Overdue · 3d")).toBeTruthy();
    expect(screen.getByText("Normal")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
  });

  it("says You for the viewer's own task and shows no phone avatar for it", () => {
    render(
      <TaskTableRow
        task={task({ dueDate: "2026-10-01", priority: "high", assignee: { type: "team", id: "u1", name: "Test Manager" } })}
        propertyLabel="Ash Flats 6"
        viewerUserId="u1"
        nowMs={NOW}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
    // One avatar — the desktop column's; the phone line drops it for the viewer.
    expect(screen.getAllByTestId("avatar")).toHaveLength(1);
  });

  it("shows the phone avatar when the task is on somebody else", () => {
    render(
      <TaskTableRow
        task={task({ assignee: { type: "team", id: "u2", name: "Dana Ramirez" } })}
        propertyLabel=""
        viewerUserId="u1"
        nowMs={NOW}
        onOpen={() => {}}
      />,
    );
    expect(screen.getAllByTestId("avatar")).toHaveLength(2);
    expect(screen.getByText("No date")).toBeTruthy();
  });
});
