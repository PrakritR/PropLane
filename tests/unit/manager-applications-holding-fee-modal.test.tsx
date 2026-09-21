// @vitest-environment jsdom
//
// Holding fee is an inline checkbox on the application detail when the listing
// has a holding deposit configured — not a header modal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) =>
    (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(ROWS),
  readManagerApplicationRows: () => ROWS,
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
  writeManagerApplicationRows: () => undefined,
  replaceManagerApplicationRowInCache: () => undefined,
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [],
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [],
}));
vi.mock("@/lib/manager-property-links", () => ({
  buildManagerShareablePropertyOptions: () => [],
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/household-charges", () => ({
  listingHoldingDepositAvailable: (propertyId: string) => propertyId === "mgr-seed-5259-brooklyn-ave-ne",
  listingHoldingDepositAmount: () => ({ amount: 500, displayLabel: "$500.00" }),
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: () => ({ ok: true, charge: { id: "chg-1", amountLabel: "$500.00" }, alreadyPaid: false }),
  removeApplicantHoldingFee: () => ({ ok: true }),
  removeAllApplicationCharges: () => false,
  removeResidentHouseholdPaymentData: () => false,
  syncHouseholdChargesFromServer: () => Promise.resolve({ charges: [], rentProfiles: [] }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

afterEach(cleanup);

describe("manager Applications — holding fee toggle on detail route", () => {
  it("shows the holding fee checkbox when the listing has a holding deposit", () => {
    ROWS = [
      {
        id: "AXIS-DEMOPRIYA",
        name: "Priya Raman",
        email: "priya.raman@test.proplane.local",
        property: "5259 Brooklyn Ave NE",
        propertyId: "mgr-seed-5259-brooklyn-ave-ne",
        stage: "Submitted",
        bucket: "pending",
        detail: "Pending review",
        application: {
          email: "priya.raman@test.proplane.local",
          propertyId: "mgr-seed-5259-brooklyn-ave-ne",
        } as DemoApplicantRow["application"],
      },
    ];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-DEMOPRIYA" />);

    expect(document.querySelector('[data-attr="application-holding-fee-toggle"]')).not.toBeNull();
    expect(document.querySelector('input[data-attr="application-holding-fee-checkbox"]')).not.toBeNull();
    expect(document.querySelector('button[data-attr="application-holding-fee-open"]')).toBeNull();
  });
});
