// @vitest-environment jsdom
/**
 * Evidence harness (visual) — Send lease now READS the terms; it never edits them.
 *
 * Renders the real `LeaseSendSheet` (the one every entry point opens) over fixture storage and
 * writes it to EVIDENCE_DIR as a page in the app's own stylesheet, for screenshotting. What the
 * screenshot has to show: "Lease terms" as plain read-only rows with a ✎ Edit resident beside the
 * heading, no date/money inputs, no "PropLane lease | Upload PDF" toggle and no "This is the lease
 * I'm sending" box, and the read-only Payments schedule under it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { writeEvidencePage } from "../helpers/evidence-page";

const APP_ID = "PROPLANE-77A1B2C3";
const LEASE_ID = "lease-77a1";

const APPLICATION = {
  id: APP_ID,
  name: "Vaishnavi Sharma",
  email: "vaishnavi@example.com",
  property: "4709A 8th Ave",
  propertyId: "prop-4709a",
  assignedPropertyId: "prop-4709a",
  managerUserId: "mgr-1",
  stage: "Approved",
  bucket: "approved",
  detail: "Approved Nov 3, 2026",
  signedMonthlyRent: "1100",
  application: {
    propertyId: "prop-4709a",
    email: "vaishnavi@example.com",
    fullLegalName: "Vaishnavi Sharma",
    roomChoice1: "prop-4709a::room-9",
    leaseStart: "2026-12-01",
    leaseEnd: "2027-11-30",
    managerRentOverride: "1100",
    managerSecurityDepositOverride: "550",
  },
} as unknown as DemoApplicantRow;

const LEASE = {
  id: LEASE_ID,
  residentName: "Vaishnavi Sharma",
  residentEmail: "vaishnavi@example.com",
  axisId: APP_ID,
  managerUserId: "mgr-1",
  propertyId: "prop-4709a",
  unit: "Room 9",
  bucket: "manager",
  status: "Manager Review",
  documentMode: "proplane-generated",
  generatedHtml: "<html><body><h1>Residential lease</h1><p>4709A 8th Ave · Room 9</p></body></html>",
  signedRentLabel: "$1,100 / month",
  application: {
    leaseStart: "2026-12-01",
    leaseEnd: "2027-11-30",
    managerRentOverride: "1100",
    managerSecurityDepositOverride: "550",
  },
};

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: () => {} }) }));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/hooks/use-manager-communication-deliver-via", () => ({
  useManagerCommunicationDeliverVia: () => ({ channelsFor: () => ["email"] }),
}));
// Demo mode keeps this screen off the network; every read below is the fixture above.
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => true,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  readManagerApplicationRows: () => [APPLICATION],
  writeManagerApplicationRows: () => undefined,
  syncManagerApplicationsFromServer: () => Promise.resolve([APPLICATION]),
  upsertApplicationRowToServerAwait: () => Promise.resolve({ ok: true }),
  normalizeApplicationAxisId: (id: string) => id,
  isBookingResidencyRow: () => false,
}));
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => ({
  // Spread the real module: this capture only overrides the reads and the writes, and a hand-listed
  // mock breaks every time the module gains an export this screen calls.
  ...(await importOriginal<typeof import("@/lib/lease-pipeline-storage")>()),
  readLeasePipeline: () => [LEASE],
  syncLeasePipelineFromServer: () => Promise.resolve(),
  ensureManagerReviewLeaseForApplication: () => ({ ok: true, row: LEASE }),
  generateLeaseHtmlForRow: () => ({ ok: true }),
  persistLeaseRowToServerAwait: () => Promise.resolve({ ok: true }),
  regenerateEditableLeasesForResident: () => undefined,
  updateLeasePipelineRow: () => undefined,
  sendLeaseToResident: () => Promise.resolve({ ok: true }),
  appendLeaseThreadMessage: () => undefined,
  confirmUploadedLeaseParseOnServer: () => Promise.resolve({ ok: true }),
  leasePipelineRowHasDocument: (row: { generatedHtml?: string | null }) => Boolean(row?.generatedHtml),
  leaseAwaitsUploadedLeaseReview: () => false,
  leaseLandlordNameWarning: () => null,
  leaseMismatchAcknowledgementGapForRow: () => null,
  leaseRecordTerms: () => null,
  leaseApplicationSnapshotForRow: (row: { application?: unknown }) => row?.application ?? null,
  leaseSendGateBlocker: () => null,
  getLeaseDocumentHtml: (row: { generatedHtml?: string | null }) => row?.generatedHtml ?? null,
}));
vi.mock("@/lib/manager-resident-account-emails", () => ({
  loadResidentAccountEmails: () => Promise.resolve(["vaishnavi@example.com"]),
}));
vi.mock("@/lib/lease-template-placement-review.client", () => ({
  confirmTemplatePlacementReviewForRow: () => Promise.resolve({ ok: true }),
  leaseNeedsTemplatePlacementReview: () => false,
}));
vi.mock("@/lib/lease-joint-room.client", () => ({ jointRoommateApplications: () => [], linkJointRoomLeases: () => undefined }));
vi.mock("@/lib/lease-fee-waiver.client", () => ({
  waiveLeaseFeeForLease: () => Promise.resolve({ ok: true }),
  reinstateLeaseFeeForLease: () => Promise.resolve({ ok: true }),
}));
vi.mock("@/lib/uploaded-lease-parse.client", () => ({ uploadAndParseLeasePdf: () => Promise.resolve({ ok: true }) }));
vi.mock("@/lib/portal-message-delivery", () => ({ deliverPortalInboxMessage: () => Promise.resolve({ ok: true }) }));
vi.mock("@/lib/application-review", () => ({ requestResidentWelcomeEmail: () => Promise.resolve({ ok: true }) }));
vi.mock("@/lib/send-forms", () => ({
  leaseFeeForSend: () => ({ fee: 0, waived: false }),
  leaseFormChoicesForApplication: () => ({ choices: [] }),
}));
vi.mock("@/lib/rental-application/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rental-application/data")>()),
  getPropertyById: () => null,
}));
import { LeaseSendSheet } from "@/components/portal/lease-send-sheet";

afterEach(cleanup);

describe("Send lease — the terms are read from the resident record", () => {
  it("draws Lease terms as read-only rows with ✎ Edit resident, and no editable terms anywhere", async () => {
    await act(async () => {
      render(
        <LeaseSendSheet
          open
          leaseId={LEASE_ID}
          applicationId={APP_ID}
          managerUserId="mgr-1"
          onClose={() => {}}
          onEditResident={() => {}}
        />,
      );
    });

    const dialog = await screen.findByRole("dialog");
    writeEvidencePage("lease-send-1-readonly-terms", dialog.outerHTML, {
      title: "Send lease — Lease terms are read-only rows from the resident record (✎ Edit resident), with Upload a PDF instead as one header icon",
      width: 1000,
      // The dialog scrolls its own body; a still has to show the whole of it.
      expandScrollers: true,
    });

    // The terms block: four read-only rows, and the one way to change them is Edit resident.
    const terms = document.querySelector('[data-attr="lease-send-terms"]') as HTMLElement;
    expect(terms).toBeTruthy();
    expect(terms.querySelectorAll("input, select, textarea")).toHaveLength(0);
    const termText = (terms.textContent ?? "").replace(/\s+/g, " ");
    expect(termText).toContain("Lease terms");
    expect(termText).toContain("Dec 1, 2026");
    expect(termText).toContain("Nov 30, 2027");
    expect(termText).toContain("$1,100");
    expect(termText).toContain("$550");
    expect(screen.getByRole("button", { name: "Edit resident" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upload a PDF instead" })).toBeTruthy();

    // What this screen deliberately no longer has.
    for (const label of ["Lease start", "Lease end", "Monthly rent", "Security deposit"]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(document.querySelector('[data-attr="lease-send-confirm-box"]')).toBeNull();
    expect(document.querySelector('[data-attr="lease-send-source-lease"]')).toBeNull();
    expect(screen.queryByText("This is the lease I'm sending")).toBeNull();
    // The schedule stays, read-only, under the terms, and its figures are the billing snapshot's.
    const schedule = document.querySelector('[data-attr="lease-send-schedule"]') as HTMLElement;
    expect(schedule).toBeTruthy();
    const scheduleText = (schedule.textContent ?? "").replace(/\s+/g, " ");
    expect(scheduleText).toContain("Deposit$550");
    expect(scheduleText).toContain("First month (prorated)$1,100");
    expect(schedule.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
});
