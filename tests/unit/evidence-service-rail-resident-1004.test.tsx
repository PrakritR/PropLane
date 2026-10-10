// @vitest-environment jsdom
//
// EVIDENCE HARNESS for two more halves of the Oct 3-4 round
// (studio plan claude-2/services-vendors-1004):
//   - the service record's rail: Service · Vendors · Incoming payments ·
//     Outgoing payments · Communication (area 1)
//   - a resident portal list in the manager Properties format (area 4)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { recordSections } from "@/lib/portals/record-sections";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import type { ResidentTourView } from "@/lib/tour-resident-link.server";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR ?? "";
const captured: { name: string; html: string }[] = [];
function capture(name: string) {
  if (!EVIDENCE_DIR) return;
  captured.push({ name, html: document.body.innerHTML });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) writeFileSync(join(EVIDENCE_DIR, `${name}.fragment.html`), html, "utf8");
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/tours",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/components/marketing/tour-schedule-flow", () => ({ TourScheduleFlow: () => <div data-testid="tour-schedule-flow" /> }));
vi.mock("@/components/marketing/property-search-picker", () => ({
  PropertySearchPicker: () => <button type="button">pick</button>,
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  isPropertyActiveForLeads: () => true,
  loadPublicExtraListingsFromServer: () => Promise.resolve([]),
  loadPublicPropertyLeadFromServer: () => Promise.resolve(undefined),
  readExtraListingsPublic: () => [],
}));
vi.mock("@/lib/public-sandbox-listings", () => ({ filterSandboxFromPublicCatalog: (list: unknown[]) => list }));
vi.mock("@/lib/public-demo-access", () => ({ isProductionPublicSite: () => false }));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => undefined,
  getPropertyForPublicLink: () => undefined,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("the service record's rail", () => {
  it("is Service · Vendors · Incoming payments · Outgoing payments · Communication", () => {
    const sections = recordSections("manager", "service", {
      basePath: "/portal",
      serviceKind: "work-order",
      serviceBucket: "open",
    });
    const body = (text: string): ReactNode => (
      <div className="p-4 text-sm text-muted">{text}</div>
    );
    render(
      <PortalRecordSectionChrome
        sections={{ ...sections, headerActions: [] }}
        recordId="wo-1"
        activeId="vendors"
        title="Burst pipe under the kitchen sink"
        subtitle="Alder House · 2B"
        backHref="/portal/services/work-orders/open"
        backLabel="All services"
        ariaLabel="Service sections"
      >
        {body("Vendors section")}
      </PortalRecordSectionChrome>,
    );
    const labels = [...document.querySelectorAll("aside a")].map((a) => a.textContent?.trim());
    for (const label of ["Service", "Vendors", "Incoming payments", "Outgoing payments", "Communication"]) {
      expect(labels, label).toContain(label);
    }
    expect(labels).not.toContain("Vendor & schedule");
    capture("service-record-rail");
  });
});

describe("a resident portal list", () => {
  const tour = (over: Partial<ResidentTourView>): ResidentTourView => ({
    inquiryId: "inq", tourGroupId: null, status: "pending", propertyId: "prop-1",
    propertyTitle: "Maple House", roomLabel: null, managerUserId: null, managerLabel: null,
    guestName: null, guestEmail: null, guestPhone: null, notes: null, instructions: null,
    proposedStart: "2026-10-10T19:00:00.000Z", proposedEnd: "2026-10-10T19:30:00.000Z",
    requestedWindows: [], createdAt: "2026-10-01T00:00:00.000Z", confirmed: false,
    confirmedStart: null, confirmedEnd: null, ...over,
  });

  it("is the Properties band with one flat card per row (resident Tours)", async () => {
    const { ResidentTourPanel } = await import("@/components/portal/resident-tour-panel");
    const future = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
    const tours = [
      tour({ inquiryId: "s1", propertyTitle: "Alder Row", proposedStart: future(5), proposedEnd: future(5) }),
      tour({ inquiryId: "a1", propertyTitle: "Maple House", confirmed: true, status: "confirmed", confirmedStart: future(6), confirmedEnd: future(6) }),
      tour({ inquiryId: "p1", propertyTitle: "Birch Studio", status: "declined" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tours }) }));
    render(<ResidentTourPanel basePath="/resident" />);
    await waitFor(() => expect(document.querySelector('[data-attr="resident-tour-section-scheduled"]')).not.toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("Alder Row"));
    capture("resident-tours-list");
  });
});

describe("which lease terms a property offers", () => {
  it("is one multi-select: Long-term and Short-term, with Custom dates and Month-to-month under Long-term", async () => {
    const { LeaseTermsField } = await import("@/components/portal/listing-wizard-v2/wizard-primitives");
    const { createDefaultListingSubmission } = await import("@/lib/manager-listing-submission");
    const { fireEvent } = await import("@testing-library/react");
    const sub = { ...createDefaultListingSubmission(), allowedLeaseTerms: ["Long-term"] };
    render(<LeaseTermsField sub={sub} onPatch={() => {}} />);
    fireEvent.click(document.querySelector('[data-attr="lease-type"]') ?? document.body);
    await waitFor(() => expect(document.body.textContent).toContain("Month-to-month"));
    for (const label of ["Long-term", "Short-term", "Custom dates", "Month-to-month"]) {
      expect(document.body.textContent, label).toContain(label);
    }
    capture("property-lease-terms-picker");
  });
});
