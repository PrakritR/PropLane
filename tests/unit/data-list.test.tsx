// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DataList } from "@/components/ui/data-list";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

describe("DataList", () => {
  it("does not render column headers or a desktop table when hideColumnHeaders is set", () => {
    const { container } = render(
      <DataList
        hideColumnHeaders
        selectable={false}
        rows={[
          {
            id: "1",
            data: { label: "Tour time" },
            primary: "Aug 6, 10:00 AM",
            meta: "Ballard House · Room 2",
            onClick: () => {},
          },
        ]}
        columns={[
          { id: "when", header: "When", cell: () => "Aug 6, 10:00 AM" },
          { id: "property", header: "Property", cell: () => "Ballard House" },
        ]}
      />,
    );

    expect(container.querySelector("thead")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByText("Aug 6, 10:00 AM")).toBeTruthy();
    expect(screen.queryByText("WHEN")).toBeNull();
    expect(screen.queryByText("PROPERTY")).toBeNull();
  });

  it("allows an inline action button without nesting buttons on mobile rows", () => {
    render(
      <DataList
        hideColumnHeaders
        selectable={false}
        rows={[
          {
            id: "app-1",
            data: { id: "app-1" },
            primary: "Submitted Jul 18, 2026",
            meta: "The Pioneer",
            onClick: () => {},
            inlineAction: (
              <Button type="button" variant="outline" data-attr="application-send-reminder">
                Send reminder
              </Button>
            ),
          },
        ]}
        columns={[{ id: "submitted", header: "Submitted", cell: () => "Submitted" }]}
      />,
    );

    const row = screen.getByRole("button", { name: /Submitted Jul 18, 2026/i });
    const inlineAction = screen.getByRole("button", { name: "Send reminder" });
    expect(row.tagName).toBe("BUTTON");
    expect(row.parentElement?.dataset.slot).toBe("data-list-mobile-row");
    expect(inlineAction.parentElement?.parentElement).toBe(row.parentElement);
    expect(row.contains(inlineAction)).toBe(false);
  });

  describe("desktop row (PRP-184 #1: no nested interactive controls)", () => {
    function renderDesktopList(onClick: () => void, onSelectedChange: () => void) {
      render(
        <DataList
          selectable
          rows={[
            {
              id: "WO-1",
              data: { id: "WO-1" },
              primary: "Kitchen sink leak",
              selected: false,
              onSelectedChange,
              onClick,
            },
          ]}
          columns={[{ id: "title", header: "Title", cell: () => <span>Kitchen sink leak</span> }]}
        />,
      );
      const table = document.querySelector("table");
      if (!table) throw new Error("expected a desktop table to render");
      return within(table);
    }

    it("activates the row via a real button, not a clickable <tr>", () => {
      const onClick = vi.fn();
      const table = renderDesktopList(onClick, vi.fn());
      const row = table.getByRole("button", { name: "Kitchen sink leak" });
      expect(row.tagName).toBe("BUTTON");
      expect(row.closest("tr")).not.toBeNull();
      fireEvent.click(row);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("never nests the row button and the selection checkbox inside each other", () => {
      const table = renderDesktopList(vi.fn(), vi.fn());
      const rowButton = table.getByRole("button", { name: "Kitchen sink leak" });
      const checkbox = table.getByLabelText("Select Kitchen sink leak");
      expect(rowButton.contains(checkbox)).toBe(false);
      expect(checkbox.contains(rowButton)).toBe(false);
    });

    it("selects without activating the row when the checkbox is clicked", () => {
      const onClick = vi.fn();
      const onSelectedChange = vi.fn();
      const table = renderDesktopList(onClick, onSelectedChange);
      fireEvent.click(table.getByLabelText("Select Kitchen sink leak"));
      expect(onSelectedChange).toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });
  });
});
