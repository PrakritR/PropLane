// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the redesigned manager resident record
// (studio plan claude-2/resident-record-tidy-1004).
//
// What it pins, and what the dumped HTML shows a reviewer:
//   1. the rail (captain's resident-record design, 2026-10-05) — RESIDENT
//      (Overview · Tours · Application · Background check) · HOME (Lease ·
//      Forms · Move in · Payments · Services · Documents · Communication),
//      with no Activity and no Inspections section of its own;
//   2. ONE record header on every section — only Edit · Delete — so
//      Background check never replaces it with its own title actions;
//   3. Background check's section row: the Run check icon (icon-only, the
//      word is the tooltip), and the consent reminder as a Bell in that row;
//   4. Application for a row that is NOT pending publishes no Approve /
//      Decline (the UI half of the defence-in-depth handler gate).
//
// `ManagerResidents` is rendered with `renderToStaticMarkup` rather than
// mounted: mounting it in jsdom never settles (an environment limit — see
// `evidence-group-house-clusters.test.tsx`), while the record chrome, rail and
// section rows are all built in render-time memos, so static markup shows the
// real surface.
//
// Set EVIDENCE_DIR to dump each rendered surface's HTML so it can be
// screenshotted with the app's real stylesheet.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { IN_PROGRESS_APPLICATION_STAGE } from "@/lib/rental-application/draft-shape";

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

const MANAGER_ID = "mgr-evidence-1";
const HOUSE = "5259 Brooklyn Ave NE";
const PROP = "mgr-evidence-house";

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

function houseProperty(): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room({ id: "room-a", name: "Room A" }), room({ id: "room-b", name: "Room B", monthlyRent: 1050 })];
  return {
    id: PROP,
    title: HOUSE,
    tagline: "",
    address: HOUSE,
    zip: "98105",
    neighborhood: "U District",
    beds: 2,
    baths: 1,
    rentLabel: "$1100/mo",
    available: "Now",
    petFriendly: false,
    buildingId: PROP,
    buildingName: HOUSE,
    unitLabel: "",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  } as MockProperty;
}

const PROPERTIES = [houseProperty()];

function applicantRow(over: Partial<DemoApplicantRow> & { id: string; name: string }): DemoApplicantRow {
  return {
    email: `${over.id.toLowerCase()}@example.com`,
    property: HOUSE,
    propertyId: PROP,
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted Oct 1, 2026",
    managerUserId: MANAGER_ID,
    ...over,
  } as DemoApplicantRow;
}

/** Submitted and waiting on a decision: Approve / Decline are live, nothing to remind about. */
const PENDING = applicantRow({
  id: "AXIS-3001",
  name: "Jordan Reyes",
  application: {
    submittedAt: "2026-10-01T18:00:00.000Z",
    propertyId: PROP,
    listingRoomId: "room-a",
    fullName: "Jordan Reyes",
    email: "axis-3001@example.com",
    phone: "206-555-0101",
    consentCredit: false,
  },
});

/** An unfinished draft: nothing to decide, and the consent reminder is offered. */
const DRAFT = applicantRow({
  id: "AXIS-3002",
  name: "Priya Nair",
  stage: IN_PROGRESS_APPLICATION_STAGE,
  detail: "Started Oct 3, 2026",
  application: {
    propertyId: PROP,
    listingRoomId: "room-b",
    fullName: "Priya Nair",
    email: "axis-3002@example.com",
    consentCredit: false,
  },
});

/** Already approved: the decision is made, so Approve / Decline must be gone. */
const APPROVED = applicantRow({
  id: "AXIS-3003",
  name: "Taylor Brooks",
  stage: "Approved",
  bucket: "approved",
  detail: "Approved Oct 2, 2026",
  manualResidentDetails: { leaseStart: "2026-11-01", leaseTerm: "12 months", roomNumber: "Room A" },
  application: {
    submittedAt: "2026-09-20T18:00:00.000Z",
    propertyId: PROP,
    listingRoomId: "room-a",
    fullName: "Taylor Brooks",
    email: "axis-3003@example.com",
    consentCredit: true,
  },
});

const ROWS: DemoApplicantRow[] = [PENDING, DRAFT, APPROVED];

vi.stubGlobal("fetch", async () =>
  new Response(JSON.stringify({ rows: [], records: [], messages: [], forms: [], ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
);

vi.mock("@/components/portal/payment-schedule-ui", () => ({
  ReminderSettingsModal: () => null,
  useScheduledPaymentMessages: () => ({ messages: [], settings: null, reload: () => Promise.resolve(), setSettings: () => {} }),
}));
vi.mock("@/components/portal/pro-payments-ledger-panel", () => ({ ManagerPaymentsLedgerPanel: () => null }));
vi.mock("@/components/portal/pro-work-orders-panel", () => ({ ManagerWorkOrdersPanel: () => null }));
vi.mock("@/components/portal/pro-resident-detail-inbox", () => ({ ManagerResidentDetailInbox: () => null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/residents",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: MANAGER_ID, email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) => (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ ok: true, stale: false }),
  readManagerApplicationRows: () => ROWS,
  deleteManagerApplicationFromServer: () => Promise.resolve({ ok: true }),
  replaceManagerApplicationRowInCache: () => {},
  writeManagerApplicationRows: () => {},
  upsertManagerApplicationRow: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
}));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-portfolio-access")>()),
  applicationVisibleToPortalUser: () => true,
  buildManagerPropertyFilterOptions: () => [],
  collectLinkedPropertyIds: () => new Set<string>(),
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
  readLinkedListingsForUser: () => [],
  resolvePropertyLabelForId: () => HOUSE,
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
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
  DEMO_GUIDED_USER_ID: "demo-everything",
  resolveManagerScopeUserId: (id: string | null) => id,
}));

import { ManagerResidents } from "@/components/portal/pro-residents";

afterEach(() => {
  cleanup();
});

/**
 * Open one resident record at one section and hand back the settled DOM.
 * Mounted (not `renderToStaticMarkup`) because the record header publishes its
 * icons into the title row through an effect — static markup falls back to the
 * pinned footer row and would not show the "one header" this change is about.
 */
async function record(residentId: string, detailTab: string): Promise<string> {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<ManagerResidents tabId="potential" residentId={residentId} detailTab={detailTab as any} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
  return document.body.innerHTML;
}

/** Every header action the record publishes, on every section. */
const HEADER_ACTIONS = [
  "Edit",
  "Delete",
];

function headerActionIds(html: string): string[] {
  return [...html.matchAll(/data-attr="record-header-action-([a-z-]+)"/g)].map((m) => m[1]!);
}
function sectionActionIds(html: string): string[] {
  return [...html.matchAll(/data-attr="resident-section-action-([a-z-]+)"/g)].map((m) => m[1]!);
}

describe("the resident record's rail and one header", () => {
  it("rails Resident · Home, with Inspections folded into Move in and no Activity", async () => {
    const html = await record(PENDING.id, "overview");
    const rail = html.slice(html.indexOf('data-slot="portal-property-rail"'));
    // Services is in the Home group of the registry (covered by
    // `record-sections-registry.test.ts`); the rail drops a section this
    // particular record has nothing in, so an applicant's rail has no Services.
    for (const label of [
      "Resident", "Overview", "Tours", "Application", "Background check",
      "Home", "Lease", "Forms", "Move in", "Payments", "Documents", "Communication",
    ]) {
      expect(rail).toContain(label);
    }
    // No Inspections or Activity section of its own — Inspections is a tab of Move in.
    expect(rail).not.toContain(">Inspections<");
    expect(rail).not.toContain(">Activity<");
    // Next step carries its own description line beside the button.
    expect(html).toContain("Application waiting for your review");
    dump("resident-record-overview", html);
  });

  it("keeps the same record header icons on Background check", async () => {
    const overview = headerActionIds(await record(PENDING.id, "overview"));
    const check = await record(PENDING.id, "background-check");
    expect(new Set(headerActionIds(check))).toEqual(new Set(overview));
    for (const label of HEADER_ACTIONS) expect(check).toContain(`aria-label="${label}"`);
  });

  it("gives every header icon an instant hover label instead of the browser's own tooltip", async () => {
    await record(PENDING.id, "overview");
    const edit = document.querySelector('[data-attr="record-header-action-edit"]') as HTMLElement;
    expect(edit).toBeTruthy();
    // The native tooltip is gone on an enabled icon — the label is ours now.
    expect(edit.getAttribute("title")).toBeNull();
    expect(document.querySelector('[data-slot="portal-icon-tooltip"]')).toBeNull();
    await act(async () => {
      fireEvent.mouseEnter(edit);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const tip = document.querySelector('[data-slot="portal-icon-tooltip"]');
    expect(tip?.textContent).toBe("Edit");
    await act(async () => {
      fireEvent.mouseLeave(edit);
    });
    expect(document.querySelector('[data-slot="portal-icon-tooltip"]')).toBeNull();
  });
});

describe("Background check's own section row", () => {
  it("offers the Run check icon, icon-only, in the tab's own header", async () => {
    const html = await record(PENDING.id, "background-check");
    expect(sectionActionIds(html)).toEqual(expect.arrayContaining(["run-check"]));
    // A non-add primary is its own glyph with the word as its aria-label, never a labelled pill.
    const run = screen.getByRole("button", { name: /Run check/ });
    expect(run).toBeTruthy();
    expect(run.textContent?.trim()).toBe("");
    dump("resident-record-background-check", html);
  });

  it("puts the consent reminder in the row as a Bell, not as header title actions", async () => {
    const html = await record(DRAFT.id, "background-check");
    expect(sectionActionIds(html)).toContain("remind-application");
    const bell = document.querySelector('[data-attr="resident-section-action-remind-application"]');
    expect(bell?.getAttribute("aria-label")).toBe("Send reminder");
    expect(bell?.querySelector("svg.lucide-bell")).toBeTruthy();
    // The record's own header is still the record's: the reminder did not replace it.
    for (const label of HEADER_ACTIONS) expect(html).toContain(`aria-label="${label}"`);
    dump("resident-record-background-check-reminder", html);
  });
});

describe("Application only offers a decision while one is pending", () => {
  it("publishes Approve and Decline for a submitted pending application", async () => {
    const html = await record(PENDING.id, "application");
    expect(sectionActionIds(html)).toEqual(expect.arrayContaining(["approve", "decline"]));
    dump("resident-record-application-pending", html);
  });

  it("publishes neither for an already approved application", async () => {
    const html = await record(APPROVED.id, "application");
    const ids = sectionActionIds(html);
    expect(ids).not.toContain("approve");
    expect(ids).not.toContain("decline");
    dump("resident-record-application-approved", html);
  });
});

describe("Move-in is a hub", () => {
  it("tabs Placement · Move-in details · Roommates · Inspections", async () => {
    const html = await record(APPROVED.id, "move-in");
    for (const label of ["Placement", "Move-in details", "Roommates", "Inspections"]) expect(html).toContain(label);
    dump("resident-record-move-in", html);
  });
});

describe("a record modal keeps its action in the footer", () => {
  it("puts Upload in the modal footer, bottom-right, not inline in the body", async () => {
    const { ManagerResidentUploadModal } = await import("@/components/portal/manager-resident-upload-modal");
    cleanup();
    render(
      <ManagerResidentUploadModal
        open
        residentName="Jordan Reyes"
        defaultKind="application"
        onClose={() => {}}
        onUploaded={async () => {}}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const submit = document.querySelector('[data-attr="resident-upload-submit"]');
    expect(submit).toBeTruthy();
    // It lives inside the modal's pinned footer band (`data-field-select-host-footer`),
    // not loose in the scrolling body.
    expect(submit!.closest("[data-field-select-host-footer]")).toBeTruthy();
    dump("resident-upload-modal", document.body.innerHTML);
  });
});
