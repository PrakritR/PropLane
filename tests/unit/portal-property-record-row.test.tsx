// @vitest-environment jsdom
/**
 * The property row (PLAN-0914-1345): the whole row is the link — no chevron
 * after the title that made "2 ›" read as a count — and bed / bath / rooms
 * are glyphs with their meaning in the accessible text.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/properties/all" }));

describe("PortalPropertyRecordRow", () => {
  it("draws the title without a chevron and the counts as glyphs", () => {
    const { container } = render(
      <PortalPropertyRecordRow
        title="41932 Paseo Padre Pkwy"
        address="Fremont, CA 94539"
        meta={{ beds: 2, baths: 1, rooms: 2 }}
        onOpen={() => {}}
        dataAttr="property-row"
      />,
    );
    const row = screen.getByRole("button", { name: /41932 Paseo Padre Pkwy/ });
    expect(row.textContent).toContain("Fremont, CA 94539");
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
    const meta = container.querySelector('[data-attr="property-row-meta"]')!;
    expect(meta.textContent).toContain("Bedrooms2");
    expect(meta.textContent).toContain("Bathrooms1");
    expect(meta.textContent).toContain("2 rooms");
  });

  it("omits the glyph line when there is nothing to count", () => {
    const { container } = render(
      <PortalPropertyRecordRow title="Jain Home" address="Seattle, WA 98105" meta={{ beds: 0, baths: 0, rooms: null }} />,
    );
    expect(container.querySelector('[data-attr="property-row-meta"]')).toBeNull();
  });
});
