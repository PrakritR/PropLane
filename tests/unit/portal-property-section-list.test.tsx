// @vitest-environment jsdom
/**
 * The property's sections, as a list.
 *
 * The rule this guards is the one the strip got wrong: a section this home
 * cannot use yet stays VISIBLE and says why. Hiding it is what made three
 * features undiscoverable on a phone in the first place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PortalPropertySectionList,
  type PortalPropertySectionItem,
} from "@/components/portal/portal-property-section-list";

const items: PortalPropertySectionItem[] = [
  {
    id: "preview",
    label: "Preview",
    description: "How renters see this home",
    href: "/portal/properties/listed/p1/preview",
    dataAttr: "property-section-row-preview",
  },
  {
    id: "application",
    label: "Application",
    description: "Screen renters online",
    href: "/portal/properties/listed/p1/application",
    dataAttr: "property-section-row-application",
    count: 3,
  },
  {
    id: "tours",
    label: "Tours",
    description: "Let renters book a viewing",
    href: "/portal/properties/listed/p1/tours",
    dataAttr: "property-section-row-tours",
    unavailableReason: "Available once this home is listed",
  },
];

// This suite renders the same component repeatedly; without cleanup the
// previous render stays in the document and every query matches twice.
afterEach(cleanup);

describe("PortalPropertySectionList", () => {
  it("says what every section is for, not just its name", () => {
    render(<PortalPropertySectionList items={items} activeId="preview" />);
    expect(screen.getByText("How renters see this home")).toBeTruthy();
    expect(screen.getByText("Screen renters online")).toBeTruthy();
  });

  it("keeps an unusable section visible and says why instead of hiding it", () => {
    render(<PortalPropertySectionList items={items} activeId="preview" />);
    const row = document.querySelector('[data-attr="property-section-row-tours"]');
    expect(row).toBeTruthy();
    // Visible, named, and explained — but not a link, so it cannot be opened.
    expect(screen.getByText("Tours")).toBeTruthy();
    expect(screen.getByText("Available once this home is listed")).toBeTruthy();
    expect(row!.tagName).not.toBe("A");
    expect(row!.getAttribute("aria-disabled")).toBe("true");
  });

  it("counts waiting work on the row, and only where there is any", () => {
    render(<PortalPropertySectionList items={items} activeId="preview" />);
    expect(screen.getByLabelText("3 waiting")).toBeTruthy();
    expect(screen.queryByLabelText("0 waiting")).toBeNull();
  });

  it("marks the section you are in", () => {
    render(<PortalPropertySectionList items={items} activeId="application" />);
    const active = document.querySelector('[aria-current="page"]');
    expect(active?.getAttribute("data-attr")).toBe("property-section-row-application");
  });

  it("never offers a link for a section it just said is unavailable", () => {
    render(<PortalPropertySectionList items={items} activeId="preview" />);
    const hrefs = [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/portal/properties/listed/p1/preview");
    expect(hrefs).not.toContain("/portal/properties/listed/p1/tours");
  });
});
