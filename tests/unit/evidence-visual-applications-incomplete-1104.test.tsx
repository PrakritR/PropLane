// @vitest-environment jsdom
/**
 * Evidence harness (visual) — the Incomplete tab, and what an unsent application offers.
 *
 * Renders the real manager Applications surface (`ManagerApplications`, the one the portal mounts)
 * and the real resident Applications panel, and writes each to EVIDENCE_DIR as a page in the app's
 * own stylesheet, for screenshotting:
 *
 *   1. the manager list with Incomplete | Pending | Approved | Declined and its own count
 *   2. an Incomplete record: Send reminder and Delete, no Approve and no Decline
 *   3. the resident's list: one row per house, an unsent draft reading
 *      "Not sent yet · n of N steps" with Continue
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { writeEvidencePage } from "../helpers/evidence-page";

let ROWS: DemoApplicantRow[] = [];
const PATH = { current: "/portal/applications/incomplete" };

vi.mock("next/navigation", () => ({
  usePathname: () => PATH.current,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "jamie.rivera@example.com", userId: "resident-test", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) => (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(ROWS),
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ rows: ROWS, ok: true }),
  readManagerApplicationRows: () => ROWS,
  replaceManagerApplicationRowInCache: () => {},
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
  writeManagerApplicationRows: () => undefined,
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [],
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [],
}));
vi.mock("@/lib/manager-property-links", () => ({ buildManagerShareablePropertyOptions: () => [] }));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-property-pipeline")>()),
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
}));
vi.mock("@/lib/cosigner-submissions-storage", () => ({
  fetchCosignerSubmissionsForSignerAppId: () => Promise.resolve([]),
  readCosignerSubmissionsForSignerAppId: () => [],
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));
vi.mock("@/lib/household-charges", () => ({
  findHoldingDepositCharge: () => undefined,
  listingHoldingDepositAvailable: () => false,
}));
vi.mock("@/lib/resident-public-nav", () => ({ residentBrowseFromApplicationHref: () => "/rent/browse" }));
vi.mock("@/components/portal/resident-application-editor", () => ({ ResidentApplicationEditor: () => null }));
vi.mock("@/components/marketing/rental-application-wizard", () => ({ RentalApplicationWizard: () => <div /> }));

import { ManagerApplications } from "@/components/portal/pro-applications";
import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";

afterEach(cleanup);

const MANAGER_ROWS: DemoApplicantRow[] = [
  {
    id: "PROPLANE-E2E86A70",
    name: "Vaishnavi Sharma",
    email: "vaishnavi@example.com",
    property: "4709A 8th Ave",
    propertyId: "prop-4709a",
    stage: "In progress",
    bucket: "pending",
    detail: "Started Nov 3, 2026",
  },
  {
    id: "PROPLANE-11B2C3D4",
    name: "Arjun Chandra",
    email: "arjun@example.com",
    property: "Ballard House",
    propertyId: "prop-ballard",
    stage: "In progress",
    bucket: "pending",
    detail: "Started Nov 4, 2026",
  },
  {
    id: "PROPLANE-22E4F5A6",
    name: "Dana Okafor",
    email: "dana@example.com",
    property: "Ballard House",
    propertyId: "prop-ballard",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted Nov 2, 2026",
  },
] as DemoApplicantRow[];

describe("manager Applications — Incomplete is its own tab", () => {
  it("lists unsent drafts under their own tab, with their own count", async () => {
    ROWS = MANAGER_ROWS;
    PATH.current = "/portal/applications/incomplete";
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<ManagerApplications bucket="incomplete" />);
    });

    writeEvidencePage("applications-1-manager-incomplete-tab", view.container.innerHTML, {
      title: "/portal/applications/incomplete — Incomplete is a list tab of its own (its count is the unsent drafts)",
      width: 1000,
    });

    // The tab strip, with each tab's own count: Incomplete is first and holds the two unsent drafts.
    const strip = (view.container.textContent ?? "").replace(/\s+/g, " ");
    expect(strip).toContain("Incomplete2Pending1Approved0Declined0".replace(/(\D)(\d)/g, "$1$2"));
    expect(screen.getAllByText("Vaishnavi Sharma").length).toBeGreaterThan(0);
    // The sent application is not in this tab.
    expect(screen.queryByText("Dana Okafor")).toBeNull();
  });

  it("an unsent application offers Send reminder and Delete — never Approve or Decline", async () => {
    ROWS = [MANAGER_ROWS[0]!];
    PATH.current = "/portal/applications/incomplete/PROPLANE-E2E86A70";
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<ManagerApplications bucket="incomplete" applicationId="PROPLANE-E2E86A70" />);
    });

    writeEvidencePage("applications-2-manager-incomplete-record", view.container.innerHTML, {
      title: "an Incomplete application's record: Send reminder and Delete, with Approve and Decline simply not offered",
      width: 1000,
    });

    expect(screen.getAllByRole("button", { name: "Send reminder" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });
});

describe("the resident's own list — one row per house, with how far the draft got", () => {
  it("reads 'Not sent yet · n of N steps' with Continue, and never lists one house twice", async () => {
    const base = {
      name: "Jamie Rivera",
      email: "jamie.rivera@example.com",
      residentUserId: "resident-test",
      application: { email: "jamie.rivera@example.com" },
    };
    ROWS = [
      // Two unsent drafts for ONE house (two tabs, two devices): the list shows the furthest along, once.
      { ...base, id: "PROPLANE-D0000001", property: "Birch Court", propertyId: "mgr-birch", stage: "In progress", bucket: "pending", detail: "Started Nov 1, 2026", application: { ...base.application, propertyId: "mgr-birch" } },
      { ...base, id: "PROPLANE-D0000002", property: "Birch Court", propertyId: "mgr-birch", stage: "In progress", bucket: "pending", detail: "Started Nov 3, 2026", application: { ...base.application, propertyId: "mgr-birch", fullLegalName: "Jamie Rivera", phone: "2065550111", currentStreet: "9 Market St", employerName: "Acme", wizardMaxStepReached: 5 } },
      { ...base, id: "PROPLANE-S0000003", property: "Magnolia House", propertyId: "mgr-magnolia", stage: "Submitted", bucket: "pending", detail: "Submitted Nov 2, 2026", application: { ...base.application, propertyId: "mgr-magnolia" } },
    ] as DemoApplicantRow[];
    PATH.current = "/resident/applications";

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<ResidentApplicationsPanel applyMode />);
    });

    writeEvidencePage("applications-3-resident-unsent-draft-row", view.container.innerHTML, {
      title: "/resident/applications — one row per house: the unsent draft reads \"Not sent yet · n of N steps\" and offers Continue",
      width: 900,
    });

    const rowText = Array.from(view.container.querySelectorAll(".portal-property-row")).map((row) =>
      (row.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    // Two rows for three stored applications: the duplicate Birch Court draft is collapsed.
    expect(rowText).toHaveLength(2);
    // The furthest-along draft is the one kept, and the row says how far it got.
    expect(rowText.join(" ")).toMatch(/Not sent yet · 4 of \d+ steps/);
    expect(screen.getAllByRole("button", { name: "Continue" }).length).toBe(1);
    expect(rowText.filter((t) => t.includes("Birch Court"))).toHaveLength(1);
  });
});
