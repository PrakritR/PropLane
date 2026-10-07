// @vitest-environment jsdom
//
// EVIDENCE HARNESS — manager resident record, Application › Rejected
// (claude-1 337e9f5d2 / d15c993bf, integrated on claude-2).
//
// The path a manager actually takes: open a submitted applicant's record on
// Application, press Reject, and the tab header becomes
// Download PDF · Move to pending · Delete application. Both restored handlers
// (`setApplicationBucket`, `deleteApplicationForRow`) are driven from those
// icons, not asserted from source.
//
// Set EVIDENCE_DIR to dump each rendered surface's HTML so it can be
// screenshotted with the app's real stylesheet.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
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

const APPLICANT_ID = "AXIS-4001";

function submittedRow(): DemoApplicantRow {
  return {
    id: APPLICANT_ID,
    name: "Dana Whitfield",
    email: "axis-4001@example.com",
    property: HOUSE,
    propertyId: PROP,
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted Oct 1, 2026",
    managerUserId: MANAGER_ID,
    application: {
      submittedAt: "2026-10-01T18:00:00.000Z",
      propertyId: PROP,
      listingRoomId: "room-a",
      fullName: "Dana Whitfield",
      email: "axis-4001@example.com",
      phone: "206-555-0144",
      consentCredit: true,
    },
  } as DemoApplicantRow;
}

/** The manager-applications store, standing in for localStorage + server. */
let ROWS: DemoApplicantRow[] = [submittedRow()];

/** What the handlers reached for, so a click can be proven rather than described. */
const calls = {
  transition: [] as { id: string; bucket: string }[],
  deleted: [] as string[],
  confirms: [] as string[],
  toasts: [] as string[],
  navigated: [] as string[],
};

vi.stubGlobal("fetch", async () =>
  new Response(JSON.stringify({ rows: [], records: [], messages: [], forms: [], ok: true, links: [] }), {
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
  useConfirm: () => (req: { description?: unknown }) => {
    calls.confirms.push(typeof req?.description === "string" ? req.description : "");
    return Promise.resolve(true);
  },
  useAppUi: () => ({ showToast: (m: string) => calls.toasts.push(m) }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => (href: string) => calls.navigated.push(href) }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
// In production this writes the store and the server; here it moves the row in
// `ROWS` so the record re-reads it exactly as it would after the round-trip.
vi.mock("@/lib/application-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/application-review")>()),
  transitionApplicationBucket: async (id: string, bucket: string) => {
    calls.transition.push({ id, bucket });
    ROWS = ROWS.map((row) =>
      row.id === id ? ({ ...row, bucket, stage: bucket === "rejected" ? "Rejected" : "Submitted" } as DemoApplicantRow) : row,
    );
    return { blocked: false, welcomeSent: false };
  },
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) => (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ ok: true, stale: false }),
  readManagerApplicationRows: () => ROWS,
  deleteManagerApplicationFromServer: (id: string) => {
    calls.deleted.push(id);
    return Promise.resolve({ ok: true });
  },
  replaceManagerApplicationRowInCache: () => {},
  writeManagerApplicationRows: (rows: DemoApplicantRow[]) => {
    ROWS = rows;
  },
  upsertManagerApplicationRow: () => Promise.resolve({ ok: true }),
  upsertApplicationRowToServerAwait: () => Promise.resolve({ ok: true }),
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
beforeEach(() => {
  ROWS = [submittedRow()];
  calls.transition.length = 0;
  calls.deleted.length = 0;
  calls.confirms.length = 0;
  calls.toasts.length = 0;
  calls.navigated.length = 0;
});

function sectionActionIds(html = document.body.innerHTML): string[] {
  return [...html.matchAll(/data-attr="resident-section-action-([a-z-]+)"/g)].map((m) => m[1]!);
}

/** Open the applicant's record on the Application tab and let it settle. */
async function openRecord(): Promise<void> {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render(<ManagerResidents tabId="potential" residentId={APPLICANT_ID} detailTab={"application" as any} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

/** Open the record and reject the application from it — how a row reaches Rejected. */
async function openRejectedRecord(): Promise<void> {
  await openRecord();
  await click("Decline");
  await waitFor(() => expect(ROWS[0]!.bucket).toBe("rejected"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

describe("resident record · Application › Rejected", () => {
  it("a submitted application still offers Reject · Edit · Download · Approve", async () => {
    await openRecord();
    expect(sectionActionIds()).toEqual(["edit", "download", "decline", "approve"]);
    dump("application-pending-before-reject", document.body.innerHTML);
  });

  it("after Reject the header becomes Download PDF · Move to pending · Delete application", async () => {
    await openRejectedRecord();
    expect(sectionActionIds()).toEqual(["download", "move-pending", "delete-application"]);
    // The decision is already taken: nothing left to approve or reject here.
    for (const gone of ["approve", "decline", "send-lease", "remind-application"]) {
      expect(sectionActionIds()).not.toContain(gone);
    }
    // Icon chrome — the word is the tooltip and aria-label, never a labelled pill.
    expect(screen.getByRole("button", { name: "Move to pending" }).textContent?.trim()).toBe("");
    expect(screen.getByRole("button", { name: "Delete application" }).textContent?.trim()).toBe("");
    dump("application-rejected-header", document.body.innerHTML);
  });

  it("Move to pending takes the decision back (the restored setApplicationBucket)", async () => {
    await openRejectedRecord();
    calls.transition.length = 0;
    calls.toasts.length = 0;

    await click("Move to pending");

    expect(calls.transition).toEqual([{ id: APPLICANT_ID, bucket: "pending" }]);
    expect(calls.toasts).toContain("Moved to pending.");
    await waitFor(() => expect(sectionActionIds()).toContain("approve"));
    // Back under Pending, with the decision live again.
    expect(sectionActionIds()).toEqual(["edit", "download", "decline", "approve"]);
    dump("application-moved-back-to-pending", document.body.innerHTML);
  });

  /**
   * Where the two new actions can be reached from, today.
   *
   * `isResidentDirectoryRow` keeps the Residents directory to approved + pending
   * rows, and the record is opened off that directory — so a row that is ALREADY
   * rejected has no record to open. The Rejected sub-tab (and with it Move to
   * pending / Delete application) is reachable only in the session where the
   * manager pressed Reject, which is the flow the cases above drive. If that
   * reach is widened later, update this case deliberately rather than deleting it.
   */
  it("a row that is already rejected has no record to open — the actions follow the reject", async () => {
    ROWS = [{ ...submittedRow(), bucket: "rejected", stage: "Rejected" } as DemoApplicantRow];
    await openRecord();
    expect(sectionActionIds()).toEqual([]);
    expect(document.body.innerHTML).not.toContain("Dana Whitfield");
  });

  it("Delete application asks first, then deletes (the restored deleteApplicationForRow)", async () => {
    await openRejectedRecord();

    await click("Delete application");

    expect(calls.confirms[0]).toContain("Delete the application for Dana Whitfield?");
    expect(calls.confirms[0]).toContain("This cannot be undone.");
    expect(calls.deleted).toEqual([APPLICANT_ID]);
    await waitFor(() => expect(calls.toasts).toContain("Application deleted."));
    // The row is gone from the store and the manager is put back on the list.
    expect(ROWS.some((row) => row.id === APPLICANT_ID)).toBe(false);
    expect(calls.navigated.at(-1)).toBe("/portal/residents/potential");
  });
});
