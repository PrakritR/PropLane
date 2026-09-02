// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

let ROWS: DemoApplicantRow[] = [];

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/applications/incomplete/PROPLANE-E2E86A70",
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
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));
vi.mock("@/lib/household-charges", () => ({
  findHoldingDepositCharge: () => undefined,
}));

import { ManagerApplications } from "@/components/portal/manager-applications";

afterEach(cleanup);

describe("manager Applications — incomplete detail reminder", () => {
  it("offers Send reminder and hides Approve on an in-progress draft", () => {
    ROWS = [
      {
        id: "PROPLANE-E2E86A70",
        name: "Applicant",
        email: "resident@test.proplane.local",
        property: "Ballard House",
        propertyId: "prop-ballard",
        stage: "In progress",
        bucket: "pending",
        detail: "Started",
      },
    ];
    render(<ManagerApplications bucket="incomplete" applicationId="PROPLANE-E2E86A70" />);

    expect(screen.getAllByText("Send reminder").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Send reminder" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.getAllByText("Reject").length).toBeGreaterThan(0);
    // The download control is no longer on the detail body: 3c23cfc2 set
    // `showDownload={false}` there and folded it into the footer's combined
    // download menu, which opens on click. This test is about Send reminder and
    // the absence of Approve, so it no longer asserts a download affordance.

    const sendReminder = screen.getAllByRole("button", { name: "Send reminder" })[0]!;
    const reject = screen.getAllByRole("button", { name: "Reject" })[0]!;
    expect(
      sendReminder.compareDocumentPosition(reject) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers Send reminder when legacy stage is stored as Incomplete", () => {
    ROWS = [
      {
        id: "PROPLANE-LEGACY",
        name: "Applicant",
        email: "resident@test.proplane.local",
        property: "Ballard House",
        propertyId: "prop-ballard",
        stage: "Incomplete",
        bucket: "pending",
        detail: "Started",
      },
    ];
    render(<ManagerApplications bucket="incomplete" applicationId="PROPLANE-LEGACY" />);
    expect(screen.getAllByText("Send reminder").length).toBeGreaterThan(0);
  });

  it("does not offer Send reminder on the Incomplete tab list", () => {
    ROWS = [
      {
        id: "PROPLANE-INCOMPLETE-LIST",
        name: "Applicant",
        email: "resident@test.proplane.local",
        property: "Ballard House",
        propertyId: "prop-ballard",
        stage: "In progress",
        bucket: "pending",
        detail: "Started",
      },
    ];
    render(<ManagerApplications bucket="incomplete" />);
    expect(screen.queryByRole("button", { name: "Send reminder" })).toBeNull();
  });
});
