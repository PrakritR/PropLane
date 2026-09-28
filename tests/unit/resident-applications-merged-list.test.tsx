// @vitest-environment jsdom
//
// C122: `ResidentApplicationsPanel` used to render three separate
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

describe("ResidentApplicationsPanel — one merged list (C122)", () => {
  it("shows pending, approved, and rejected applications together with no bucket tabs", async () => {
    ROWS = [
      rowFor("PROPLANE-PEND1", "pending", "Alder Row"),
      rowFor("PROPLANE-APPR1", "approved", "Maple Duplex"),
      rowFor("PROPLANE-REJ1", "rejected", "Birch Studio"),
    ];

    await act(async () => {
      render(<ResidentApplicationsPanel />);
    });

    expect(screen.getAllByText(/Alder Row/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Maple Duplex/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Birch Studio/).length).toBeGreaterThan(0);
    // No tab-bar destinations left to pick a bucket from.
    expect(document.querySelector('[data-attr="resident-applications-bucket-pending"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-applications-bucket-approved"]')).toBeNull();
    expect(document.querySelector('[data-attr="resident-applications-bucket-rejected"]')).toBeNull();
  });

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
