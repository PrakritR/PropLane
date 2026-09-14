/** @vitest-environment jsdom */
/**
 * The Tasks table put every value under the wrong heading.
 *
 * `RowSelectCheckbox` turns into the trailing `⋯` record menu whenever a
 * `RecordActionContext` is present, and that menu carries `order-last`. With
 * auto-placement that vacated grid column 1, so the task title fell into the
 * 28px select column (rendering as "Lu…") and property/assignee/due/priority
 * each slid one column left of their own header.
 *
 * Every cell now places itself explicitly, so no `order-*` utility on any
 * child can shift the row out of step with the header again.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TaskTableHeader, TASK_ROW_GRID } from "@/components/portal/pro-task-row";

describe("Tasks table columns", () => {
  it("gives the title the flexible column, not a 28px one", () => {
    expect(TASK_ROW_GRID).toContain("minmax(0,1fr)_minmax(0,150px)");
    // The old grid led with a 28px select column, which is what crushed the title.
    expect(TASK_ROW_GRID).not.toContain("28px_minmax(0,1fr)");
  });

  it("places every header cell explicitly so source order cannot shift it", () => {
    const { container } = render(<TaskTableHeader />);
    const cells = Array.from(container.querySelectorAll("span"));
    expect(cells).toHaveLength(6);
    cells.forEach((cell, i) => {
      expect(cell.className).toContain(`md:[grid-column:${i + 1}]`);
    });
  });

  it("keeps the headers in the order a manager reads them", () => {
    const { container } = render(<TaskTableHeader />);
    const labels = Array.from(container.querySelectorAll("span")).map((s) => s.textContent);
    expect(labels).toEqual(["Task", "Property", "Assignee", "Due", "Priority", ""]);
  });
});
