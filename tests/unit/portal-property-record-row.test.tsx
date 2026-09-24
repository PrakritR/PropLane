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
  it("draws bath / room / resident glyphs — never bedrooms", () => {
    const { container } = render(
      <PortalPropertyRecordRow
        title="41932 Paseo Padre Pkwy"
        address="Fremont, CA 94539"
        meta={{ baths: 1, rooms: 2, residents: 3 }}
        onOpen={() => {}}
        dataAttr="property-row"
      />,
    );
    const row = screen.getByRole("button", { name: /41932 Paseo Padre Pkwy/ });
    expect(row.textContent).toContain("Fremont, CA 94539");
    expect(container.querySelector("svg.lucide-chevron-right")).toBeNull();
    const meta = container.querySelector('[data-attr="property-row-meta"]')!;
    expect(meta.textContent).not.toContain("Bedrooms");
    expect(meta.textContent).toContain("Bathrooms1");
    expect(meta.textContent).toContain("2 rooms");
    expect(meta.textContent).toContain("Residents3");
  });

  it("omits the glyph line when there is nothing to count", () => {
    const { container } = render(
      <PortalPropertyRecordRow title="Jain Home" address="Seattle, WA 98105" meta={{ baths: 0, rooms: null, residents: null }} />,
    );
    expect(container.querySelector('[data-attr="property-row-meta"]')).toBeNull();
  });
});
