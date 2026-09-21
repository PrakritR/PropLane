// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Mail, Pencil, Trash2 } from "lucide-react";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import type { RecordSections } from "@/lib/portals/record-sections";

afterEach(cleanup);

function fixtureSections(overrides: Partial<RecordSections> = {}): RecordSections {
  return {
    groups: [
      {
        label: "Payment",
        items: [
          { id: "overview", label: "Overview", href: (id: string) => `/portal/payments/${id}` },
          { id: "resident", label: "Resident", href: (id: string) => `/portal/payments/${id}/resident` },
        ],
      },
      {
        label: "",
        items: [
          { id: "communication", label: "Communication", href: (id: string) => `/portal/payments/${id}/communication` },
          { id: "documents", label: "Documents", href: (id: string) => `/portal/payments/${id}/documents` },
        ],
      },
    ],
    headerActions: [
      { id: "record-payment", label: "Record payment", icon: Mail },
      { id: "edit", label: "Edit", icon: Pencil },
      { id: "delete", label: "Delete", icon: Trash2, tone: "danger" },
    ],
    phonePrimary: "record-payment",
    ...overrides,
  };
}

describe("record page phone chip strip", () => {
  it("renders a chip below lg for every section, the active one marked current", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="resident"
        title="Rent · September"
        backHref="/portal/payments"
        backLabel="All payments"
        ariaLabel="Payment sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    const strip = screen.getByRole("navigation", { name: "Payment sections" });
    const links = within(strip).getAllByRole("link");
    // Every section across every group — own sections plus the trio.
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Resident", "Communication", "Documents"]);
    const active = within(strip).getByRole("link", { name: "Resident" });
    expect(active.getAttribute("aria-current")).toBe("page");
    const inactive = within(strip).getByRole("link", { name: "Overview" });
    expect(inactive.getAttribute("aria-current")).toBeNull();
  });

  it("carries no sub-line under a chip — a label and nothing else", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Rent · September"
        backHref="/portal/payments"
        backLabel="All payments"
        ariaLabel="Payment sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    const strip = screen.getByRole("navigation", { name: "Payment sections" });
    const overviewChip = within(strip).getByRole("link", { name: "Overview" });
    // The chip's only text node is the label itself — no muted explainer span.
    expect(overviewChip.querySelectorAll("p").length).toBe(0);
    expect(overviewChip.textContent?.trim()).toBe("Overview");
  });

  it("shows the phone sticky primary action when the registry names one", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections()}
        recordId="rec_1"
        activeId="overview"
        title="Rent · September"
        backHref="/portal/payments"
        backLabel="All payments"
        ariaLabel="Payment sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    const primary = document.querySelector('[data-attr="record-sticky-primary-record-payment"]');
    expect(primary).not.toBeNull();
    expect(primary?.textContent).toContain("Record payment");
  });

  it("omits the sticky action entirely when the registry has no phonePrimary", () => {
    render(
      <PortalRecordSectionChrome
        sections={fixtureSections({ phonePrimary: undefined })}
        recordId="rec_1"
        activeId="overview"
        title="Rent · September"
        backHref="/portal/payments"
        backLabel="All payments"
        ariaLabel="Payment sections"
      >
        <p>body</p>
      </PortalRecordSectionChrome>,
    );
    expect(document.querySelector('[data-attr="record-sticky-action"]')).toBeNull();
  });
});
