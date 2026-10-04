// @vitest-environment jsdom
//
// C122 (superseded for the list by C1-R1's Sent | Approved | Denied sections): `ResidentApplicationsPanel` used to render three separate
// Pending/Approved/Rejected tabs, each filtering the list to its own bucket.
// This asserts the list view is now ONE list covering every bucket at once
// (no `resident-applications-bucket-*` tab destinations left in the DOM), with
// status read per row as text, and that the individual application's record
// page surfaces an application-fee fact alongside status and answers — the
// three things the change's title names.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const PROPERTY_ID = "mgr-test-merged";

function application(over: Partial<RentalWizardFormState>): RentalWizardFormState {
  return { propertyId: PROPERTY_ID, roomChoice1: "", fullLegalName: "Jamie Rivera", ...over } as RentalWizardFormState;
}

let ROWS: DemoApplicantRow[] = [];
let searchParams = new URLSearchParams();
const mocks = vi.hoisted(() => ({ feeCharge: null as null | { amountLabel: string; status: string } }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => vi.fn() }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: () => {},
  cancelPendingApplicationRowUpsert: () => {},
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/resident-public-nav", () => ({ residentBrowseFromApplicationHref: () => "/rent/browse" }));
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
  getRoomChoiceLabel: (value: string) => value,
  parseRoomChoiceValue: (value: string) => ({ listingRoomId: value.split("::")[1] ?? value }),
}));
vi.mock("@/components/portal/pro-applications", () => ({
  applicationPdfHref: () => "/api/manager-applications/test/pdf?disposition=inline",
  ApplicationDocumentPreview: () => null,
}));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-finish-panel", () => ({ GroupShareCallout: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({ RentalApplicationWizard: () => null }));
vi.mock("@/lib/household-charges", () => ({
  findApplicationFeeCharge: () => mocks.feeCharge,
}));

import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

afterEach(() => {
  cleanup();
  ROWS = [];
  mocks.feeCharge = null;
  searchParams = new URLSearchParams();
});

function rowFor(id: string, bucket: DemoApplicantRow["bucket"], name: string): DemoApplicantRow {
  return {
    id,
    name,
    email: "jamie.rivera@example.com",
    property: `${name} House`,
    propertyId: PROPERTY_ID,
    stage: bucket === "approved" ? "Approved" : bucket === "rejected" ? "Declined" : "Submitted",
    bucket,
    detail: "Submitted",
    application: application({ roomChoice1: `${PROPERTY_ID}::room-1` }),
  };
}

describe("ResidentApplicationsPanel — Sent | Approved | Denied sections (C1-R1)", () => {
  const rows = () => [
    rowFor("PROPLANE-PEND1", "pending", "Alder Row"),
    rowFor("PROPLANE-APPR1", "approved", "Maple Duplex"),
    rowFor("PROPLANE-REJ1", "rejected", "Birch Studio"),
  ];

  it("opens on Sent, with counts on all three tabs and the other sections' rows hidden", async () => {
    ROWS = rows();
    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });
    const tab = (id: string) => document.querySelector(`[data-attr="resident-applications-section-${id}"]`) as HTMLElement;
    expect(tab("sent").textContent).toContain("Sent");
    expect(tab("sent").textContent).toContain("1");
    expect(tab("approved").textContent).toContain("Approved");
    expect(tab("denied").textContent).toContain("Denied");
    // The old Long term | Short term tabs are gone.
    expect(screen.queryByText("Long-term", { selector: "button *, button" })).toBeNull();
    expect(screen.getAllByText(/Alder Row/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Maple Duplex/).length).toBe(0);
    expect(screen.queryAllByText(/Birch Studio/).length).toBe(0);
  });

  it("switching tabs shows that section's applications, no status word on the row", async () => {
    ROWS = rows();
    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });
    await act(async () => {
      (document.querySelector('[data-attr="resident-applications-section-approved"]') as HTMLElement).click();
    });
    expect(screen.getAllByText(/Maple Duplex/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Alder Row/).length).toBe(0);
    await act(async () => {
      (document.querySelector('[data-attr="resident-applications-section-denied"]') as HTMLElement).click();
    });
    expect(screen.getAllByText(/Birch Studio/).length).toBeGreaterThan(0);
    // The tab names the bucket; the row carries no coloured status word.
    expect(screen.queryByText("Denied", { selector: "span.font-semibold" })).toBeNull();
    expect(document.querySelector('[data-attr="resident-applications-list"]')).toBeTruthy();
  });

  it("a draft is just a Sent row that reads Started, with no Incomplete word and no group header", async () => {
    ROWS = [
      { ...rowFor("PROPLANE-DRAFT1", "pending", "Alder Row"), stage: "In progress", detail: "Started 2026-10-03" },
      rowFor("PROPLANE-APPR1", "approved", "Maple Duplex"),
    ];
    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });
    expect(screen.queryByText("Incomplete")).toBeNull();
    expect(screen.getByText(/Started/)).toBeTruthy();
    expect(document.querySelector('[data-attr="portal-list-group"], [data-slot="portal-list-group"]')).toBeNull();
  });
});

describe("ResidentApplicationsPanel — record page (C122)", () => {
  it("surfaces the application fee as a fact on the record page's Overview", async () => {
    mocks.feeCharge = { amountLabel: "$50.00", status: "paid" };
    ROWS = [rowFor("PROPLANE-FEE1", "pending", "Alder Row")];

    await act(async () => {
      render(<ResidentApplicationsPanel applicationId="PROPLANE-FEE1" bucket="pending" />);
    });

    expect(screen.getByText("Application fee")).toBeTruthy();
    expect(screen.getByText("$50.00 · Paid")).toBeTruthy();
  });

  it("reads a waived fee honestly rather than guessing a charge exists", async () => {
    ROWS = [
      {
        ...rowFor("PROPLANE-FEE2", "pending", "Alder Row"),
        application: application({ roomChoice1: `${PROPERTY_ID}::room-1`, applicationFeeWaived: true }),
      },
    ];

    await act(async () => {
      render(<ResidentApplicationsPanel applicationId="PROPLANE-FEE2" bucket="pending" />);
    });

    expect(screen.getByText("Waived")).toBeTruthy();
  });
});
