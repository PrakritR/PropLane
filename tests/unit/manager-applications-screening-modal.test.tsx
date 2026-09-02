// @vitest-environment jsdom
//
// Regression: application detail route returned before mounting CheckrScreeningModal,
// so "Run background check" set state but no popup appeared.
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
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/household-charges", () => ({
  findHoldingDepositCharge: () => undefined,
}));
// Spread the real module and override only the demo flags. A hand-listed mock
// breaks the file the moment the module grows an export a component imports —
// which is what `DEMO_NAVIGATE_EVENT` did.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/manager-applications";

afterEach(cleanup);

describe("manager Applications — screening modal on detail route", () => {
  it("opens the Checkr package picker when Run background check is clicked on the detail page", () => {
    ROWS = [
      {
        id: "AXIS-DEMOSOFID",
        name: "Sofia Diaz",
        email: "sofia.diaz.workflow@test.proplane.local",
        property: "Ballard House",
        propertyId: "prop-ballard",
        stage: "Submitted",
        bucket: "approved",
        detail: "Approved",
        application: {
          consentCredit: true,
          email: "sofia.diaz.workflow@test.proplane.local",
        } as DemoApplicantRow["application"],
      },
    ];

    render(<ManagerApplications bucket="approved" applicationId="AXIS-DEMOSOFID" />);

    const runBtn = document.querySelector('[data-attr="run-background-check"]');
    expect(runBtn).not.toBeNull();
    fireEvent.click(runBtn!);

    expect(screen.getByText(/Run screening · Sofia Diaz/i)).toBeTruthy();
    expect(screen.getByText("Select a package")).toBeTruthy();
  });
});
