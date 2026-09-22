// @vitest-environment jsdom
/**
 * `PortalEntryRow` (PLAN-0921-1029) is the one row every list renders: tile ·
 * title with an optional attention dot · place line · up to three glyph
 * facts · a right-hand figure with a one-word sub-label · the shared ⋯. No
 * `Badge`, no pill, no inline button beyond the row's own open control
 * (`tests/unit/portal-list-rows-no-pills.test.ts` covers the list-row source
 * files; this covers the shared component's own source and behaviour).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DollarSign } from "lucide-react";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/payments" }));

describe("PortalEntryRow source", () => {
  it("draws no Badge or status chip", () => {
    const source = readFileSync(join(process.cwd(), "src/components/portal/portal-entry-row.tsx"), "utf8");
    expect(source).not.toMatch(/<Badge\b/);
    expect(source).not.toMatch(/PortalRowStatusChip/);
  });
});

describe("PortalEntryRow", () => {
  it("renders the tile, title, place line, facts and figure", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <PortalEntryRow
        tile={{ kind: "initials", label: "Test Resident" }}
        title="Rent · Oct 2026"
        place="Test Resident · Lakeview Studio · due Oct 1"
        facts={[{ icon: DollarSign, label: "Rent" }, "Bank transfer"]}
        figure={{ value: "$1,800", subLabel: "Pending" }}
        onOpen={onOpen}
        dataAttr="entry-row-test"
      />,
    );
    const row = screen.getByRole("button", { name: /Rent · Oct 2026/ });
    expect(row.textContent).toContain("Test Resident · Lakeview Studio · due Oct 1");
    expect(row.textContent).toContain("Rent");
    expect(row.textContent).toContain("Bank transfer");
    expect(row.textContent).toContain("$1,800");
    expect(row.textContent).toContain("Pending");
    // The row itself opens the record; nothing else on the row is a separate
    // clickable button (no selection handler, no ⋯ context provided here).
    expect(container.querySelectorAll("button")).toHaveLength(1);
    row.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("accepts a node (not just a string) for a fact's label — e.g. a caller's own data-attr", () => {
    render(
      <PortalEntryRow
        tile={{ kind: "glyph", icon: DollarSign }}
        title="Rent · Oct 2026"
        facts={[{ icon: DollarSign, label: <span data-attr="stamped-fact">Reminder Aug 28, 2026</span> }]}
        onOpen={() => {}}
      />,
    );
    const stamped = screen.getByText("Reminder Aug 28, 2026");
    expect(stamped.getAttribute("data-attr")).toBe("stamped-fact");
  });

  it("caps facts at three", () => {
    render(
      <PortalEntryRow
        tile={{ kind: "glyph", icon: DollarSign }}
        title="Four facts"
        facts={["One", "Two", "Three", "Four"]}
        onOpen={() => {}}
      />,
    );
    const factsLine = screen.getByText("One").closest("p");
    expect(factsLine?.textContent).toContain("One");
    expect(factsLine?.textContent).toContain("Three");
    expect(factsLine?.textContent).not.toContain("Four");
  });

  it("shows a blue attention dot before the title only when asked", () => {
    const { container: withDot } = render(
      <PortalEntryRow tile={{ kind: "glyph", icon: DollarSign }} title="Overdue rent" attention onOpen={() => {}} />,
    );
    expect(withDot.querySelector(".bg-primary")).not.toBeNull();

    const { container: withoutDot } = render(
      <PortalEntryRow tile={{ kind: "glyph", icon: DollarSign }} title="Settled rent" onOpen={() => {}} />,
    );
    expect(withoutDot.querySelector(".bg-primary")).toBeNull();
  });

  it("colours the figure red when overdue and green when settled", () => {
    const { container: bad } = render(
      <PortalEntryRow
        tile={{ kind: "glyph", icon: DollarSign }}
        title="Rent"
        figure={{ value: "$1,800", tone: "bad" }}
        onOpen={() => {}}
      />,
    );
    const badFigure = bad.querySelector(".text-red-600");
    expect(badFigure?.textContent).toBe("$1,800");

    const { container: ok } = render(
      <PortalEntryRow
        tile={{ kind: "glyph", icon: DollarSign }}
        title="Rent"
        figure={{ value: "$1,800", tone: "ok" }}
        onOpen={() => {}}
      />,
    );
    const okFigure = ok.querySelector(".text-emerald-600");
    expect(okFigure?.textContent).toBe("$1,800");
  });

  it("renders a round tile for initials and a photo for a photo tile", () => {
    const { container: initials } = render(
      <PortalEntryRow tile={{ kind: "initials", label: "Maya Chen" }} title="Maya Chen" onOpen={() => {}} />,
    );
    expect(initials.textContent).toContain("MC");
    expect(initials.querySelector(".rounded-full")).not.toBeNull();

    const { container: photo } = render(
      <PortalEntryRow
        tile={{ kind: "photo", src: "https://example.com/house.jpg", alt: "Cascade Lofts" }}
        title="Cascade Lofts"
        onOpen={() => {}}
      />,
    );
    expect(photo.querySelector('img[src="https://example.com/house.jpg"]')).not.toBeNull();
  });
});
