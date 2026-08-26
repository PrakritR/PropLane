// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataList } from "@/components/ui/data-list";
import { Button } from "@/components/ui/button";

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
    expect(row.tagName).toBe("DIV");
    expect(screen.getByRole("button", { name: "Send reminder" })).toBeTruthy();
  });
});
