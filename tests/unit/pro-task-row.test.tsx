// @vitest-environment jsdom
//
// The shared task card row: due state from wall dates, facts derived from the
// row data, and no pills. It is the Payments row: initials tile, title, place line, one dated fact.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskListCardRow, taskDueFact, taskDueLabel, taskDueState } from "@/components/portal/pro-task-row";
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

describe("taskDueLabel", () => {
  it("reads Due for upcoming days and Overdue (same glyph, no pill) for past ones", () => {
    expect(taskDueLabel(task({ dueDate: "2026-09-25" }), formatRange, NOW)).toBe("Due Sep 25");
    expect(taskDueLabel(task({ dueDate: "2026-09-10" }), formatRange, NOW)).toBe("Overdue Sep 10");
    expect(taskDueLabel(task({}), formatRange, NOW)).toBe("No due date");
    expect(
      taskDueLabel(task({ start: "2026-09-25T13:30:00Z", end: "2026-09-25T14:30:00Z" }), formatRange, NOW),
    ).toBe("Due RANGE(2026-09-25T13:30:00Z–2026-09-25T14:30:00Z)");
  });
});

describe("TaskListCardRow", () => {
  it("is the Payments card: initials tile, task title, place line, one dated fact, no figure", () => {
    render(
      <TaskListCardRow
        task={task({ dueDate: "2999-10-05", assignee: { type: "team", id: "u1", name: "Dana Ramirez" } })}
        propertyLabel="Ash Flats 6"
        formatRange={formatRange}
        onSelectedChange={() => {}}
        onOpen={() => {}}
        dataAttr="manager-task-row"
      />,
    );
    expect(screen.getByText("Fix the porch light")).toBeTruthy();
    expect(screen.getByText("Ash Flats 6")).toBeTruthy();
    expect(screen.getByText("DR")).toBeTruthy();
    expect(screen.getByText(/^Due Oct 5, 2999$/)).toBeTruthy();
    // Assignee and priority ride the tile, not extra facts or pills.
    expect(screen.queryByText("Dana Ramirez")).toBeNull();
    expect(screen.queryByText("Normal")).toBeNull();
    const card = document.querySelector(".portal-property-row");
    expect(card?.className).toContain("rounded-xl");
    expect(card?.className).toContain("mb-3");
    const factLine = document.querySelector('[data-attr="record-row-facts"]');
    expect(factLine?.querySelector("svg")).toBeTruthy();
  });

  it("shows the property glyph instead of initials when nobody is assigned", () => {
    render(
      <TaskListCardRow task={task({ dueDate: "2999-10-05" })} propertyLabel="Ash Flats 6" formatRange={formatRange} onOpen={() => {}} />,
    );
    expect(document.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeTruthy();
  });

  it("reads an overdue task as Overdue with the same glyph, no red pill", () => {
    render(
      <TaskListCardRow task={task({ dueDate: "2020-10-02" })} propertyLabel="Ash Flats 6" formatRange={formatRange} onOpen={() => {}} />,
    );
    expect(screen.getByText("Overdue Oct 2, 2020")).toBeTruthy();
    const row = document.querySelector(".portal-property-row");
    expect(row?.querySelector('[class*="rounded-full"][class*="bg-"]')).toBeNull();
  });

  it("shows a completed date instead of the due fact on the Done tab", () => {
    render(
      <TaskListCardRow
        task={task({ completed: true, updatedAt: "2026-09-09" })}
        propertyLabel=""
        formatRange={formatRange}
        showDoneDate
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/^Completed Sep 9/)).toBeTruthy();
  });
});
