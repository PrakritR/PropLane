// @vitest-environment jsdom
//
// Regression: the holding fee moved from an inline card in the application
// detail body to a "Holding fee" header action, but ApplicationHoldingFeeModal
// is mounted only in the LIST branch — the detail route returns before it — so
// the button set state and nothing opened. Same shape as the earlier
// CheckrScreeningModal detail-route regression.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
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
// PARTIAL mock: the panel keeps picking up new readers from this module, and a fully-replaced
// mock throws on the first export it does not name — three appeared in a row here. Spreading the
// real module stubs only the network-touching calls and lets new readers keep working.
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
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: () => ({ ok: true, charge: { id: "chg-1" }, alreadyPaid: false }),
  removeApplicantHoldingFee: () => ({ ok: true }),
  removeAllApplicationCharges: () => false,
  removeResidentHouseholdPaymentData: () => false,
  syncHouseholdChargesFromServer: () => Promise.resolve({ charges: [], rentProfiles: [] }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

afterEach(cleanup);

describe("manager Applications — holding fee modal on detail route", () => {
  it("opens the Holding fee modal when the header action is clicked on the detail page", () => {
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

    const openBtn = document.querySelector('button[data-attr="application-holding-fee-open"]');
    expect(openBtn).not.toBeNull();
    fireEvent.click(openBtn!);

    expect(document.querySelector('[data-attr="application-holding-fee-modal"]')).not.toBeNull();
    expect(screen.getByText(/hold the home while you review/i)).toBeTruthy();
  });
});
