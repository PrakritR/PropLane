// @vitest-environment jsdom
/**
 * Render regression + evidence harness: holding fee toggle on application detail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
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
  listingHoldingDepositAvailable: (propertyId: string) => Boolean(propertyId.trim()),
  listingHoldingDepositAmount: () => ({ amount: 500, displayLabel: "$500.00" }),
  findHoldingDepositCharge: () => undefined,
  setApplicantHoldingFee: () => ({ ok: true, charge: { id: "chg-1" }, alreadyPaid: false }),
  removeApplicantHoldingFee: () => ({ ok: true }),
  removeAllApplicationCharges: () => false,
  removeResidentHouseholdPaymentData: () => false,
  syncHouseholdChargesFromServer: () => Promise.resolve({ charges: [], rentProfiles: [] }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/pro-applications";

afterEach(cleanup);

const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<p style="font:600 13px/1.4 system-ui;color:#64748b;margin:16px auto 0;max-width:1100px;padding:0 16px">${caption}</p>
${body}</body></html>`,
  );
}

describe("evidence · holding fee toggle on the application detail", () => {
  it("shows the checkbox when the listing has a holding deposit", () => {
    ROWS = [
      {
        id: "AXIS-1002",
        name: "Priya Nair",
        email: "priya.nair@example.com",
        property: "The Pioneer",
        propertyId: "mgr-demo-pioneer",
        stage: "Submitted",
        bucket: "pending",
        detail: "Submitted Jul 19, 2026",
        application: {
          email: "priya.nair@example.com",
          propertyId: "mgr-demo-pioneer",
        } as DemoApplicantRow["application"],
      },
    ];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-1002" applicationDetailTab="application-form" />);
    expect(document.querySelector('[data-attr="application-holding-fee-toggle"]')).not.toBeNull();
    writeShot(
      "holding-fee-toggle",
      "Application detail — holding fee checkbox when the listing offers a holding deposit.",
      document.body.innerHTML,
    );
  });

  it("hides the toggle when the listing has no holding deposit", () => {
    ROWS = [
      {
        id: "AXIS-1009",
        name: "Sam Okafor",
        email: "sam.okafor@example.com",
        property: "",
        propertyId: "",
        stage: "In progress",
        bucket: "pending",
        detail: "Started Jul 20, 2026",
        application: { email: "sam.okafor@example.com", propertyId: "" } as DemoApplicantRow["application"],
      },
    ];

    render(<ManagerApplications bucket="pending" applicationId="AXIS-1009" />);
    expect(document.querySelector('[data-attr="application-holding-fee-toggle"]')).toBeNull();
    writeShot(
      "holding-fee-hidden",
      "Application with no property — holding fee toggle is not shown.",
      document.body.innerHTML,
    );
  });
});
