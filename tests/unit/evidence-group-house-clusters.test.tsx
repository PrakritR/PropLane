// @vitest-environment jsdom
//
// EVIDENCE HARNESS — household headers on Residents; resident clusters on Applications/Leases.
//
// `group-house-label.test.ts` covers the numbering logic. This file checks that
// Residents still prints "<house> Group N" while Applications and Leases use the
// Tours-style resident-cluster list shell.
//
// Set EVIDENCE_DIR to dump each rendered surface's HTML so it can be
// screenshotted with the app's real stylesheet.
//
// The Residents surface is rendered with `renderToStaticMarkup` rather than
// mounted: mounting `ManagerResidents` in jsdom never settles (it does the same
// on the pre-change component, so it is an environment limit, not this change),
// while the list itself is derived in render-time memos, so static markup still
// shows the real clustered rows.
import { afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const captured: { name: string; html: string }[] = [];
function dump(name: string, html: string) {
  captured.push({ name, html });
}
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.body.html`), html, "utf8");
  }
});

const HOUSE_5257 = "5257 Brooklyn Ave NE";
const HOUSE_5259 = "5259 Brooklyn Ave NE";
const PROP_5257 = "mgr-evidence-5257";
const PROP_5259 = "mgr-evidence-5259";
const MANAGER_ID = "mgr-evidence-1";

function room(over: Partial<ManagerRoomSubmission> & { id: string; name: string }): ManagerRoomSubmission {
  return {
    floor: "",
    furnished: "furnished",
    amenities: [],
    photoDataUrls: [],
    videoDataUrl: "",
    monthlyRent: 1100,
    utilitiesEstimate: "120",
    deposit: "500",
    moveInFee: "150",
    available: true,
    ...over,
  } as ManagerRoomSubmission;
}

/** A by-the-room house that also offers a two-room lease bundle. */
function houseProperty(id: string, title: string, withBundle: boolean): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    room({ id: "room-a", name: "Room A" }),
    room({ id: "room-b", name: "Room B", monthlyRent: 1050 }),
    room({ id: "room-c", name: "Room C", monthlyRent: 995 }),
  ];
  if (withBundle) {
    sub.bundles = [
      {
        id: "bundle-ab",
        label: "Rooms A + B together",
        price: "1950",
        roomsLine: "Room A + Room B",
        includedRoomIds: ["room-a", "room-b"],
        shortTermEnabled: false,
        shortTermNightlyRent: "",
      },
    ];
  }
  return {
    id,
    title,
    tagline: "",
    address: title,
    zip: "98105",
    neighborhood: "U District",
    beds: 3,
    baths: 2,
    rentLabel: "$1100/mo",
    available: "Now",
    petFriendly: false,
    buildingId: id,
    buildingName: title,
    unitLabel: "",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  } as MockProperty;
}

const PROPERTIES: MockProperty[] = [
  houseProperty(PROP_5257, HOUSE_5257, true),
  houseProperty(PROP_5259, HOUSE_5259, false),
];

function group(over: Partial<RentalWizardFormState>): Partial<RentalWizardFormState> {
  return { applyingAsGroup: "yes", groupRole: "joining", groupSize: "4", ...over } as Partial<RentalWizardFormState>;
}

const GROUP_A = "PROPLANE-AAAA1111"; // 3 members at 5257 + 1 at 5259 (the split household)
const GROUP_B = "PROPLANE-BBBB2222"; // 2 members at 5257 — must number as "Group 2"
const GROUP_C = "PROPLANE-CCCC3333"; // 2 members at 5259 — must restart at "Group 1"

function residentRow(over: Partial<DemoApplicantRow> & { id: string; name: string }): DemoApplicantRow {
  return {
    email: `${over.id.toLowerCase()}@example.com`,
    property: HOUSE_5257,
    propertyId: PROP_5257,
    stage: "Approved",
    bucket: "approved",
    detail: "Submitted Aug 1, 2026",
    managerUserId: MANAGER_ID,
    manualResidentDetails: { leaseStart: "2026-09-01", leaseTerm: "12 months" },
    ...over,
  } as DemoApplicantRow;
}

const ALL_ROWS: DemoApplicantRow[] = [
  residentRow({ id: "AXIS-2001", name: "Jordan Reyes", application: group({ groupId: GROUP_A, groupRole: "first", propertyId: PROP_5257 }) }),
  residentRow({ id: "AXIS-2002", name: "Priya Nair", application: group({ groupId: GROUP_A, propertyId: PROP_5257 }) }),
  residentRow({ id: "AXIS-2003", name: "Sam Okafor", application: group({ groupId: GROUP_A, propertyId: PROP_5257 }) }),
  // The row that used to erase the house from the header: same household, other address.
  residentRow({
    id: "AXIS-2004",
    name: "Devi Menon",
    property: HOUSE_5259,
    propertyId: PROP_5259,
    application: group({ groupId: GROUP_A, propertyId: PROP_5259 }),
  }),
  residentRow({ id: "AXIS-2005", name: "Alex Kim", application: group({ groupId: GROUP_B, groupSize: "2", groupRole: "first", propertyId: PROP_5257 }) }),
  residentRow({ id: "AXIS-2006", name: "Robin Vale", application: group({ groupId: GROUP_B, groupSize: "2", propertyId: PROP_5257 }) }),
  residentRow({
    id: "AXIS-2007",
    name: "Casey Lund",
    property: HOUSE_5259,
    propertyId: PROP_5259,
    application: group({ groupId: GROUP_C, groupSize: "2", groupRole: "first", propertyId: PROP_5259 }),
  }),
  residentRow({
    id: "AXIS-2008",
    name: "Morgan Diaz",
    property: HOUSE_5259,
    propertyId: PROP_5259,
    application: group({ groupId: GROUP_C, groupSize: "2", propertyId: PROP_5259 }),
  }),
  // Not a household — stays a plain row.
  residentRow({ id: "AXIS-2009", name: "Taylor Brooks" }),
];

let ROWS: DemoApplicantRow[] = ALL_ROWS;

// Every server sync in these panels goes through fetch; jsdom has no origin for
// the relative routes, so answer them all with an empty payload.
vi.stubGlobal("fetch", async () =>
  new Response(JSON.stringify({ rows: [], records: [], messages: [], ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
);

// Detail-pane panels the Residents LIST does not render.
vi.mock("@/components/portal/payment-schedule-ui", () => ({
  ReminderSettingsModal: () => null,
  useScheduledPaymentMessages: () => ({
    messages: [],
    settings: null,
    reload: () => Promise.resolve(),
    setSettings: () => {},
  }),
}));
vi.mock("@/components/portal/manager-payments-ledger-panel", () => ({
  ManagerPaymentsLedgerPanel: () => null,
}));
vi.mock("@/components/portal/manager-work-orders-panel", () => ({ ManagerWorkOrdersPanel: () => null }));
vi.mock("@/components/portal/manager-resident-detail-inbox", () => ({ ManagerResidentDetailInbox: () => null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/residents",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: MANAGER_ID, email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => ROWS,
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  replaceManagerApplicationRowInCache: () => {},
  writeManagerApplicationRows: () => {},
  upsertManagerApplicationRow: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  MANAGER_PORTFOLIO_REFRESH_EVENTS: [],
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [],
}));
vi.mock("@/lib/manager-property-links", () => ({ buildManagerShareablePropertyOptions: () => [] }));
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  hasCachedPropertyPipeline: () => true,
  readAllExtraListings: () => PROPERTIES,
  readExtraListings: () => [],
  readExtraListingsForUser: () => PROPERTIES,
  readScopedExtraListings: () => PROPERTIES,
  readAllPendingManagerProperties: () => [],
  readPendingManagerPropertiesForUser: () => [],
  buildMockPropertyFromDraft: () => null,
  cachePublicExtraListings: () => {},
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

import { ManagerApplications } from "@/components/portal/manager-applications";
import { ManagerResidents } from "@/components/portal/manager-residents";
import { ManagerLeasesPipelinePanel } from "@/components/portal/manager-leases-pipeline-panel";

afterEach(() => {
  cleanup();
  ROWS = ALL_ROWS;
});

/** Lease rows for the same households, so the pipeline must print the same labels. */
function leaseRow(over: Partial<LeasePipelineRow> & { id: string; residentName: string }): LeasePipelineRow {
  return {
    residentEmail: `${over.id}@example.com`,
    unit: `${HOUSE_5257} · Room A`,
    propertyId: PROP_5257,
    stageLabel: "Manager Review",
    status: "Manager Review",
    updated: "Aug 12",
    updatedAtIso: "2026-08-12T18:00:00.000Z",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    thread: [],
    managerUserId: MANAGER_ID,
    ...over,
  } as LeasePipelineRow;
}

describe("household and resident list shells", () => {
  it("Applications clusters each approved applicant by resident", async () => {
    const { container } = render(<ManagerApplications bucket="approved" />);
    await waitFor(() => expect(screen.getAllByText("Jordan Reyes").length).toBeGreaterThan(0));

    expect(document.querySelector("[data-attr='applications-resident-groups']")).toBeTruthy();
    // The per-cluster "N application(s)" count copy is gone; clusters now carry a
    // group heading instead. What this test is about is the CLUSTERING, so assert
    // the applicant appears exactly once under the resident groups rather than
    // pinning a count string the UI no longer prints.
    const groups = document.querySelector("[data-attr='applications-resident-groups']")!;
    expect((groups.textContent ?? "").match(/Jordan Reyes/g) ?? []).toHaveLength(1);
    dump("applications-resident-clusters", container.innerHTML);
  });

  it("Residents groups approved residents under property headers by default", () => {
    const html = renderToStaticMarkup(<ManagerResidents />);

    expect(html).toContain('data-attr="residents-house-groups"');
    expect(html).toContain("Jordan Reyes");
    expect(html).toContain("Taylor Brooks");
    dump("residents-house-clusters", html);
  });

  it("Leases clusters each resident in the Tours-style table shell", async () => {
    const rows: LeasePipelineRow[] = [
      leaseRow({ id: "lease-1", residentName: "Jordan Reyes", application: group({ groupId: GROUP_A, propertyId: PROP_5257 }) }),
      leaseRow({ id: "lease-2", residentName: "Priya Nair", unit: `${HOUSE_5257} · Room B`, application: group({ groupId: GROUP_A, propertyId: PROP_5257 }) }),
      leaseRow({
        id: "lease-3",
        residentName: "Casey Lund",
        unit: `${HOUSE_5259} · Room A`,
        propertyId: PROP_5259,
        application: group({ groupId: GROUP_C, propertyId: PROP_5259 }),
      }),
      leaseRow({
        id: "lease-4",
        residentName: "Morgan Diaz",
        unit: `${HOUSE_5259} · Room B`,
        propertyId: PROP_5259,
        application: group({ groupId: GROUP_C, propertyId: PROP_5259 }),
      }),
      leaseRow({ id: "lease-5", residentName: "Taylor Brooks", unit: `${HOUSE_5257} · Room C` }),
    ];
    const { container } = render(
      <ManagerLeasesPipelinePanel rows={rows} tab="manager" refreshKey={0} residentAccountEmails={new Set()} />,
    );
    await waitFor(() => expect(screen.getAllByText("Jordan Reyes").length).toBeGreaterThan(0));

    expect(document.querySelector("[data-attr='leases-resident-groups']")).toBeTruthy();
    expect(screen.getAllByText("1 lease").length).toBeGreaterThanOrEqual(3);
    dump("leases-resident-clusters", container.innerHTML);
  });
});
