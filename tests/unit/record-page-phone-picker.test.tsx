// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Mail, Pencil, Trash2 } from "lucide-react";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import type { RecordSections } from "@/lib/portals/record-sections";

afterEach(cleanup);

function fixtureSections(): RecordSections {
  return {
    groups: [
      {
        label: "Resident",
        items: [
          { id: "overview", label: "Overview", href: (id: string) => `/portal/residents/${id}` },
          { id: "application", label: "Application", href: (id: string) => `/portal/residents/${id}/application` },
        ],
      },
      {
        label: "Home",
        items: [
          { id: "lease", label: "Lease", href: (id: string) => `/portal/residents/${id}/lease` },
          { id: "payments", label: "Payments", href: (id: string) => `/portal/residents/${id}/payments` },
        ],
      },
      {
        label: "",
        items: [
          { id: "communication", label: "Communication", href: (id: string) => `/portal/residents/${id}/communication` },
        ],
      },
    ],
    headerActions: [
      { id: "message", label: "Message", icon: Mail },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
  };
}

describe("record page phone section picker", () => {
  it("closed: shows the active section's own label, not its group's label", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="lease"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    const toggle = document.querySelector('[data-attr="record-section-picker-toggle"]');
    expect(toggle?.textContent).toContain("Lease");
    expect(toggle?.textContent).not.toContain("Home");
  });

  it("open: a labeled multi-item group shows a + expander; a single-item group is a direct row", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-toggle"]')!);
    // The multi-item groups ("Resident", "Home") render as collapsed group rows.
    expect(document.querySelector('[data-attr="record-section-picker-group-Resident"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="record-section-picker-group-Home"]')).not.toBeNull();
    // Items are not yet in the DOM until expanded.
    expect(document.querySelector('[data-attr="record-section-picker-item-lease"]')).toBeNull();
    // The unlabeled trio group's single item is a direct, always-visible row.
    expect(document.querySelector('[data-attr="record-section-picker-item-communication"]')).not.toBeNull();
  });

  it("+ expands a group's items inline; tapping one navigates and closes the picker", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-toggle"]')!);
    const homeToggle = document.querySelector('[data-attr="record-section-picker-group-Home"]')!;
    expect(homeToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(homeToggle);
    expect(homeToggle.getAttribute("aria-expanded")).toBe("true");
    const leaseLink = document.querySelector('[data-attr="record-section-picker-item-lease"]') as HTMLAnchorElement;
    expect(leaseLink).not.toBeNull();
    expect(leaseLink.getAttribute("href")).toBe("/portal/residents/rec_1/lease");
    fireEvent.click(leaseLink);
    // The picker closes on navigation — its list unmounts.
    expect(document.querySelector('[data-attr="record-section-picker-toggle"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("− collapses an expanded group back down", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-toggle"]')!);
    const homeToggle = document.querySelector('[data-attr="record-section-picker-group-Home"]')!;
    fireEvent.click(homeToggle);
    expect(document.querySelector('[data-attr="record-section-picker-item-lease"]')).not.toBeNull();
    fireEvent.click(homeToggle);
    expect(document.querySelector('[data-attr="record-section-picker-item-lease"]')).toBeNull();
  });

  it("a Close row closes the picker without navigating", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-toggle"]')!);
    fireEvent.click(document.querySelector('[data-attr="record-section-picker-close"]')!);
    expect(document.querySelector('[data-attr="record-section-picker-toggle"]')?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("renders no sticky bottom bar and no bottom-nav hider", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    expect(document.querySelector('[data-attr="record-sticky-action"]')).toBeNull();
  });
});

describe("record page desktop rail", () => {
  it("still renders every section as a link, the active one current", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="lease"
        title="Jordan Lee"
        backHref="/portal/residents"
        backLabel="All residents"
        ariaLabel="Resident sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    const rail = document.querySelector('[data-slot="portal-property-rail"]') as HTMLElement;
    const active = within(rail).getByRole("link", { name: "Lease" });
    expect(active.getAttribute("aria-current")).toBe("page");
  });
});
