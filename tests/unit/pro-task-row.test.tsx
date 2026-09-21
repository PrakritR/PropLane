// @vitest-environment jsdom
//
// The shared task card row: due state from wall dates, facts derived from the
// row data, no pills, and priority named only when it is not Normal.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskListCardRow, taskDueFact, taskDueState } from "@/components/portal/pro-task-row";
import type { ManagerTask } from "@/lib/manager-tasks";

// Fri Sep 11 2026, 19:30 local.
const NOW = new Date(2026, 8, 11, 19, 30).getTime();
const formatRange = (start: string, end: string) => `RANGE(${start}–${end})`;

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

describe("taskDueFact", () => {
  it("formats a bare due date", () => {
    expect(taskDueFact(task({ dueDate: "2026-09-25" }), formatRange)).toBe("Fri, Sep 25");
  });

  it("uses the range formatter for a timed slot", () => {
    expect(
      taskDueFact(task({ start: "2026-09-25T13:30:00Z", end: "2026-09-25T14:30:00Z" }), formatRange),
    ).toBe("RANGE(2026-09-25T13:30:00Z–2026-09-25T14:30:00Z)");
  });

  it("falls back to No date", () => {
    expect(taskDueFact(task({}), formatRange)).toBe("No date");
  });
});

describe("TaskListCardRow", () => {
  it("is a card, not a table: title, place line, due/assignee facts, Normal priority stays silent", () => {
    render(
      <TaskListCardRow
        task={task({ dueDate: "2026-09-08" })}
        propertyLabel="Ash Flats 6"
        viewerUserId="u1"
        formatRange={formatRange}
        onOpen={() => {}}
        dataAttr="manager-task-row"
      />,
    );
    expect(screen.getByText("Fix the porch light")).toBeTruthy();
    expect(screen.getByText("Ash Flats 6")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    // Normal priority never shows — only High/Low earn a fact.
    expect(screen.queryByText("Normal")).toBeNull();
    const row = document.querySelector('[data-attr="manager-task-row"]');
    // No table grid, no pill-shaped badge classes on the row.
    expect(row?.className).not.toContain("grid");
  });

  it("says You for the viewer's own task and names a non-Normal priority", () => {
    render(
      <TaskListCardRow
        task={task({ dueDate: "2026-10-01", priority: "high", assignee: { type: "team", id: "u1", name: "Test Manager" } })}
        propertyLabel="Ash Flats 6"
        viewerUserId="u1"
        formatRange={formatRange}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("High")).toBeTruthy();
  });

  it("shows a completed date instead of the due fact on the Done tab", () => {
    render(
      <TaskListCardRow
        task={task({ completed: true, updatedAt: "2026-09-09" })}
        propertyLabel=""
        viewerUserId="u1"
        formatRange={formatRange}
        showDoneDate
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Wed, Sep 9")).toBeTruthy();
  });
});
