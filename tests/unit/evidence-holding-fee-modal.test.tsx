// @vitest-environment jsdom
/**
 * Render regression + evidence harness: opens the "Holding fee" header
 * action on a real application detail route and dumps the modal markup to
 * EVIDENCE_DIR (when set) for screenshotting.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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
  readAllExtraListings: () => [],
  readExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  cachePublicExtraListings: () => {},
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
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerApplications } from "@/components/portal/manager-applications";

// Same convention as `evidence-manager-money-agreement.test.tsx`: the render is
// always exercised, the HTML is only written when EVIDENCE_DIR asks for it.
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

describe("evidence · holding fee is a header action on the application detail", () => {
  it("opens the modal for an application that has a house on it", () => {
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

    render(<ManagerApplications bucket="pending" applicationId="AXIS-1002" />);
    fireEvent.click(document.querySelector('button[data-attr="application-holding-fee-open"]')!);
    expect(document.querySelector('[data-attr="application-holding-fee-modal"]')).not.toBeNull();
    writeShot(
      "holding-fee-modal",
      "G · Application detail → 'Holding fee' header action opens the modal (it used to be an inline card, and on the detail route the button opened nothing).",
      document.body.innerHTML,
    );
    document.body.innerHTML = "";
  });

  it("explains itself when the application has no house yet", () => {
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
    fireEvent.click(document.querySelector('button[data-attr="application-holding-fee-open"]')!);
    expect(
      document.querySelector('[data-attr="application-holding-fee-unavailable"]')?.textContent,
    ).toContain("no house on it yet");
    writeShot(
      "holding-fee-blocked",
      "H · Same action on an application with no house selected — the modal says why instead of showing an empty body.",
      document.body.innerHTML,
    );
    document.body.innerHTML = "";
  });
});
