// @vitest-environment jsdom
//
// C050/C065 — "Generate lease" appears inline on an approved application.
//
// One primary action under Overview on an APPROVED application, in an
// application-first workspace, opens the same lease wizard the Leases tab
// uses (ManagerAddLeaseModal), pre-filled with this applicant — never a
// separate page. A lease-first workspace never gates a lease on application
// approval at all, so the card must not appear there; a pending/rejected/
// withdrawn row must not show it either.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  DEFAULT_LEASING_PIPELINE,
  type LeasingPipelinePreferences,
} from "@/lib/leasing-pipeline-preferences";

let ROWS: DemoApplicantRow[] = [];
let LEASING_PREFS: LeasingPipelinePreferences = DEFAULT_LEASING_PIPELINE;
let lastAddLeaseModalProps: Record<string, unknown> | null = null;

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
  listingHoldingDepositAvailable: () => false,
  listingHoldingDepositAmount: () => ({ amount: 0, displayLabel: "$0.00" }),
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: () => ({ ok: true, charge: { id: "chg-1", amountLabel: "$0.00" }, alreadyPaid: false }),
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
vi.mock("@/lib/leasing-pipeline-client-cache", () => ({
  readCachedLeasingPipelinePreferences: () => LEASING_PREFS,
}));
vi.mock("@/components/portal/pro-add-lease-modal", () => ({
  ManagerAddLeaseModal: (props: Record<string, unknown>) => {
    lastAddLeaseModalProps = props;
    if (!props.open) return null;
    return <div data-attr="stub-add-lease-modal">{String(props.initialApplicationId)}</div>;
  },
}));

import { ManagerApplications } from "@/components/portal/pro-applications";
import { leaseSendRequiresApprovedApplication } from "@/lib/leasing-pipeline-preferences";

function approvedRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-GENLEASE-1",
    name: "Jordan Chen",
    email: "jordan.chen@test.proplane.local",
    property: "5257 Brooklyn Ave NE",
    propertyId: "mgr-seed-5257-brooklyn-ave-ne",
    stage: "Approved",
    bucket: "approved",
    detail: "Approved",
    application: {
      email: "jordan.chen@test.proplane.local",
      propertyId: "mgr-seed-5257-brooklyn-ave-ne",
    } as DemoApplicantRow["application"],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  LEASING_PREFS = DEFAULT_LEASING_PIPELINE;
  lastAddLeaseModalProps = null;
});

describe("Generate lease — inline on an approved application (C050/C065)", () => {
  it("shows the primary action in an application-first workspace and opens the wizard pre-filled", () => {
    expect(leaseSendRequiresApprovedApplication(DEFAULT_LEASING_PIPELINE)).toBe(true);
    ROWS = [approvedRow()];

    render(<ManagerApplications bucket="approved" applicationId="AXIS-GENLEASE-1" />);

    const card = document.querySelector('[data-attr="record-overview-card-generate-lease"]');
    expect(card).not.toBeNull();
    const button = card!.querySelector("button");
    expect(button?.textContent).toContain("Generate lease");

    fireEvent.click(button!);

    expect(document.querySelector('[data-attr="stub-add-lease-modal"]')).not.toBeNull();
    expect(lastAddLeaseModalProps?.initialApplicationId).toBe("AXIS-GENLEASE-1");
  });

  it("is absent in a lease-first workspace", () => {
    LEASING_PREFS = { ...DEFAULT_LEASING_PIPELINE, pipelineOrder: "lease_then_application" };
    ROWS = [approvedRow()];

    render(<ManagerApplications bucket="approved" applicationId="AXIS-GENLEASE-1" />);

    expect(document.querySelector('[data-attr="record-overview-card-generate-lease"]')).toBeNull();
  });

  it("is absent on a pending (not yet approved) application", () => {
    ROWS = [approvedRow({ id: "AXIS-GENLEASE-2", bucket: "pending", stage: "Submitted" })];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-GENLEASE-2" />);

    expect(document.querySelector('[data-attr="record-overview-card-generate-lease"]')).toBeNull();
  });

  it("is absent on a withdrawn approved application", () => {
    ROWS = [approvedRow({ id: "AXIS-GENLEASE-3", withdrawnAt: "2026-01-01T00:00:00.000Z" })];

    render(<ManagerApplications bucket="approved" applicationId="AXIS-GENLEASE-3" />);

    expect(document.querySelector('[data-attr="record-overview-card-generate-lease"]')).toBeNull();
  });
});
