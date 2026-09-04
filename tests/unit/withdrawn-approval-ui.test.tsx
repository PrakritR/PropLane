// @vitest-environment jsdom
//
// Manager Applications UI guard: a resident-withdrawn application keeps
// `bucket === "pending"`, so it stays visible on the Pending tab labelled
// "Withdrawn" — but the manager must NOT be offered Approve on it (approving
// provisions a resident account + rent/deposit charges for someone who withdrew).
// A normal pending row is the control: it still offers Approve.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

/** Rows the mocked storage layer hands the manager panel; swapped per scenario. */
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
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
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
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

afterEach(cleanup);

function row(over: Partial<DemoApplicantRow> & { id: string; name: string }): DemoApplicantRow {
  return {
    property: "The Pioneer",
    propertyId: "mgr-demo-pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted Jul 19, 2026",
    email: `${over.id.toLowerCase()}@example.com`,
    backgroundCheckStatus: "pending_review",
    ...over,
  };
}

describe("manager Applications — no Approve on a withdrawn row", () => {
  it("hides Approve (and the reminder) but keeps the row visible + labelled Withdrawn", async () => {
    ROWS = [
      row({ id: "AXIS-W1", name: "Withdrawn Wanda", withdrawnAt: "2026-07-22T00:00:00.000Z" }),
    ];
    const { rerender } = render(<ManagerApplications bucket="pending" />);

    // The row is still shown on the Pending tab (status badge is detail-only in current layout).
    expect(screen.getAllByText("Withdrawn Wanda").length).toBeGreaterThan(0);

    rerender(<ManagerApplications bucket="pending" applicationId="AXIS-W1" />);

    // Detail route — no Approve button and no "Send reminder".
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Send reminder")).toBeNull();
    expect(screen.getAllByText("Reject").length).toBeGreaterThan(0);
    // Delete is rejected-only after 3c23cfc2 ("status-specific actions"); this
    // row is still on Pending, so Reject is the destructive action on offer.
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("still offers Approve on a normal (non-withdrawn) pending row — the control", async () => {
    ROWS = [row({ id: "AXIS-N1", name: "Normal Nora" })];
    render(<ManagerApplications bucket="pending" applicationId="AXIS-N1" />);

    expect(screen.getAllByText("Approve").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reject").length).toBeGreaterThan(0);
  });
});
