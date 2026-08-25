// @vitest-environment jsdom
/**
 * Two things the product used to let a manager do, both with Send fully enabled
 * and no warning anywhere:
 *
 * - send a binding lease to an applicant whose application was still pending
 *   review (F-APP-3), and
 * - send a lease whose document named a different tenant, at a different rent,
 *   for a different term than the record the page was headed with (F-LEASE-1).
 *
 * The audit's example was seeded data, so the mismatched CONTENT was probably a
 * seed artifact. The product bug is that nothing objected. These pin the
 * objection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { seedDemoManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  confirmUploadedLeaseParse,
  leaseApplicationApprovalBlocker,
  leaseDocumentMismatchesForRow,
  leaseMismatchAcknowledgementGapForRow,
  leaseNeedsUploadedLeaseReviewAction,
  leaseSendHeldByUploadedLeaseReview,
  leaseSendStillReachable,
  ensureManagerReviewLeaseForApplication,
  readLeasePipeline,
  seedDemoLeasePipeline,
  sendLeaseToResident,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { buildUploadedLeaseParse } from "@/lib/uploaded-lease-extraction";

const MANAGER_ID = "manager-send-guards";
const ROW_ID = "lease_send_guard_1";
const AXIS_ID = "AXIS-SENDGUARD1";
const PDF = "data:application/pdf;base64,JVBERi0xLjQKR1VBUkQ=";

function leaseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: ROW_ID,
    axisId: AXIS_ID,
    residentName: "Diego Morales",
    residentEmail: "diego.morales@example.com",
    unit: "Cascade Lofts · Unit 2A",
    stageLabel: "Manager Review",
    updated: "Aug 1",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: "<html><body>GENERATED LEASE</body></html>",
    managerUploadedPdf: null,
    status: "Manager Review",
    signedRentLabel: "$1,050.00 / month",
    application: { leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    ...overrides,
  };
}

function applicationRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: AXIS_ID,
    name: "Diego Morales",
    email: "diego.morales@example.com",
    property: "Cascade Lofts",
    stage: "Approved",
    bucket: "approved",
    detail: "",
    managerUserId: MANAGER_ID,
    // `syncApprovedApplications` re-derives the lease row's `signedRentLabel`
    // from here on every read, so the rent has to live on the application for
    // the row to carry one at all.
    signedMonthlyRent: 1050,
    ...overrides,
  };
}

function storedRow(): LeasePipelineRow | undefined {
  return readLeasePipeline(MANAGER_ID).find((r) => r.id === ROW_ID);
}

function resetStores() {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/portal/leases");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
}

describe("a lease cannot be sent to an applicant who has not been approved", () => {
  beforeEach(resetStores);

  it("refuses while the application is still pending review", async () => {
    seedDemoManagerApplicationRows([applicationRow({ bucket: "pending", stage: "Submitted" })], MANAGER_ID);
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    const blocker = leaseApplicationApprovalBlocker(storedRow()!);
    expect(blocker).toMatch(/has not been approved/i);
    expect(blocker).toMatch(/still pending review/i);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/has not been approved/i);
    expect(storedRow()?.status).toBe("Manager Review");
    expect(storedRow()?.sentToResidentAt ?? null).toBeNull();
  });

  it("refuses on a rejected application, and says which state it is in", async () => {
    seedDemoManagerApplicationRows([applicationRow({ bucket: "rejected", stage: "Rejected" })], MANAGER_ID);
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).error).toMatch(/was rejected/i);
  });

  it("refuses when the applicant withdrew, even if the row is still bucketed approved", async () => {
    seedDemoManagerApplicationRows(
      [applicationRow({ withdrawnAt: "2026-08-02T00:00:00.000Z" })],
      MANAGER_ID,
    );
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).error).toMatch(/withdrew/i);
  });

  it("sends once the application is approved", async () => {
    seedDemoManagerApplicationRows([applicationRow()], MANAGER_ID);
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    expect(leaseApplicationApprovalBlocker(storedRow()!)).toBeNull();
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
    expect(storedRow()?.status).toBe("Resident Signature Pending");
  });

  it("bumps the document version when pending section edits are materialized on send", async () => {
    seedDemoManagerApplicationRows([applicationRow()], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: `<!doctype html><html><body><h2>Rent</h2><p>Due on the first.</p></body></html>`,
          managerSectionEdits: { rent: { format: "text", value: "Due on the fifth." } },
          versionNumber: 1,
          pdfVersion: 1,
        }),
      ],
      MANAGER_ID,
    );

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(true);
    expect(storedRow()?.versionNumber).toBe(2);
    expect(String(storedRow()?.generatedHtml)).toContain("Due on the fifth.");
  });

  /**
   * Fails OPEN by design. An existing resident onboarded off-platform has no
   * application, and the applications store loads lazily — refusing on absence
   * would block real sends and read as exactly the "leases not sending" report
   * this guard was added under.
   */
  it("does not block a lease that has no application behind it at all", async () => {
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    expect(leaseApplicationApprovalBlocker(storedRow()!)).toBeNull();
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });

  it("matches the application by email when the lease row carries no Axis id", async () => {
    seedDemoManagerApplicationRows([applicationRow({ id: "some-other-id", bucket: "pending" })], MANAGER_ID);
    seedDemoLeasePipeline([leaseRow({ axisId: undefined })], MANAGER_ID);

    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
  });
});

/**
 * The document the manager is about to send has to describe the tenancy the
 * page is about. Every comparison is deliberately conservative — a false
 * mismatch blocks a legitimate send and teaches managers to click past the
 * warning — so agreement cases are pinned as hard as disagreement cases.
 */
describe("a lease document that contradicts its record is not sent silently", () => {
  beforeEach(resetStores);

  function uploadedWith(pages: string[], rowOverrides: Partial<LeasePipelineRow> = {}) {
    const parse = buildUploadedLeaseParse({
      pages,
      fileName: "lease.pdf",
      sourceSha256: "a".repeat(64),
      extractedAtIso: "2026-08-01T00:00:00.000Z",
    });
    seedDemoManagerApplicationRows([applicationRow()], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: null,
          managerUploadedPdf: {
            dataUrl: PDF,
            originalDataUrl: PDF,
            fileName: "lease.pdf",
            uploadedAt: "2026-08-01T00:00:00.000Z",
          },
          uploadedLeaseParse: parse,
          ...rowOverrides,
        }),
      ],
      MANAGER_ID,
    );
  }

  const WRONG_PARTY_PAGES = [
    "RESIDENTIAL LEASE\nTenant: Shivansh Nikhra\nLandlord: The Pioneer",
    "Monthly rent is $1,450.00 per month. The term commences on March 1, 2026 and ends on February 28, 2027.",
  ];

  it("names the tenant, the rent and the term that disagree", async () => {
    uploadedWith(WRONG_PARTY_PAGES);

    const mismatches = leaseDocumentMismatchesForRow(storedRow()!);
    const byKey = Object.fromEntries(mismatches.map((m) => [m.key, m]));

    expect(Object.keys(byKey).sort()).toEqual(["leaseEnd", "leaseStart", "monthlyRent", "tenantName"]);
    expect(byKey.tenantName?.documentValue).toContain("Shivansh Nikhra");
    expect(byKey.tenantName?.recordValue).toBe("Diego Morales");
    expect(byKey.monthlyRent?.documentValue).toContain("1,450.00");
    expect(byKey.monthlyRent?.recordValue).toContain("1050.00");

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    // Says exactly what disagrees, rather than a bare refusal.
    expect(result.error).toContain("Shivansh Nikhra");
    expect(result.error).toContain("Diego Morales");
    expect(storedRow()?.status).toBe("Manager Review");
  });

  it("sends once the manager has confirmed the review, which is the acknowledgement", async () => {
    uploadedWith(WRONG_PARTY_PAGES);

    expect(
      confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" }).ok,
    ).toBe(true);

    // Still reported — the disagreement is a fact about the document, not a
    // dismissible banner — but no longer a refusal.
    expect(leaseDocumentMismatchesForRow(storedRow()!).length).toBeGreaterThan(0);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });

  it("says nothing when the document agrees with the record", async () => {
    uploadedWith([
      "RESIDENTIAL LEASE\nTenant: Diego Morales",
      "Monthly rent is $1,050.00 per month. The term commences on September 1, 2026 and ends on August 31, 2027.",
    ]);

    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
  });

  it("tolerates the ways a real lease writes the same party", async () => {
    uploadedWith([
      "RESIDENTIAL LEASE\nTenant: Diego A. Morales and Jane Doe",
      "Monthly rent is $1,050.00 per month. The term commences on 2026-09-01 and ends on August 31, 2027.",
    ]);

    // Co-tenants, a middle initial, and an ISO date against a written one: all
    // the same tenancy, none of them a disagreement.
    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
  });

  it("does not invent a disagreement out of a term the document never states", async () => {
    uploadedWith(["RESIDENTIAL LEASE\nTenant: Diego Morales", "The parties agree as follows."]);

    // Rent and term are `not_found` — already blank-and-flagged in the review.
    // Treating an unread term as a disagreement would flag every document.
    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
  });

  it("reports nothing for a natively generated lease, which is built from the record", async () => {
    seedDemoManagerApplicationRows([applicationRow()], MANAGER_ID);
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);

    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });
});

/**
 * An acknowledgement is a statement about a document AND about the record it
 * was compared to. `confirmedDocumentSha256` pins the first; without the second,
 * a manager who accepts a document's differences and then edits the rent has
 * their acknowledgement silently carried onto terms they never saw — the
 * document never changed, so the digest still matches and the guard waves it
 * through. Same F-LEASE-1 class, reached by a different sequence.
 */
describe("a confirmation covers the record it was made against, not any later one", () => {
  beforeEach(resetStores);

  const AGREEING_PAGES = [
    "RESIDENTIAL LEASE\nTenant: Diego Morales",
    "Monthly rent is $1,050.00 per month. The term commences on September 1, 2026 and ends on August 31, 2027.",
  ];

  function seedConfirmedUpload(appOverrides: Partial<DemoApplicantRow> = {}) {
    const parse = buildUploadedLeaseParse({
      pages: AGREEING_PAGES,
      fileName: "lease.pdf",
      sourceSha256: "a".repeat(64),
      extractedAtIso: "2026-08-01T00:00:00.000Z",
    });
    seedDemoManagerApplicationRows([applicationRow(appOverrides)], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: null,
          managerUploadedPdf: {
            dataUrl: PDF,
            originalDataUrl: PDF,
            fileName: "lease.pdf",
            uploadedAt: "2026-08-01T00:00:00.000Z",
          },
          uploadedLeaseParse: parse,
        }),
      ],
      MANAGER_ID,
    );
    expect(confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat" }).ok).toBe(true);
  }

  it("re-gates when the record changes under a confirmed, agreeing lease", async () => {
    seedConfirmedUpload();
    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);

    // The manager renegotiates the rent. The document is untouched, so the
    // document digest still matches — only the record moved.
    resetStores();
    seedConfirmedUpload();
    const confirmedParse = storedRow()!.uploadedLeaseParse!;
    seedDemoManagerApplicationRows([applicationRow({ signedMonthlyRent: 1450 })], MANAGER_ID);
    seedDemoLeasePipeline(
      [leaseRow({ generatedHtml: null, managerUploadedPdf: storedRow()!.managerUploadedPdf, uploadedLeaseParse: confirmedParse })],
      MANAGER_ID,
    );

    expect(leaseMismatchAcknowledgementGapForRow(storedRow()!)).toBe("record_changed");
    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/record has changed since/i);
    expect(result.error).toContain("1,050.00");
  });

  it("does not re-gate a lease whose document still agrees after a record edit", async () => {
    seedConfirmedUpload();
    const confirmedParse = storedRow()!.uploadedLeaseParse!;
    const upload = storedRow()!.managerUploadedPdf;

    // A record change that cannot alter the answer — the document states no
    // landlord, so editing one could never create a disagreement.
    seedDemoLeasePipeline(
      [leaseRow({ generatedHtml: null, managerUploadedPdf: upload, uploadedLeaseParse: confirmedParse, notes: "edited" })],
      MANAGER_ID,
    );

    expect(leaseDocumentMismatchesForRow(storedRow()!)).toEqual([]);
    expect(leaseMismatchAcknowledgementGapForRow(storedRow()!)).toBeNull();
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });

  /**
   * The gate must cover everything the SEND PATHS accept, which is wider than
   * what the manager can edit: both `sendLeaseToResident` and the agent's
   * `send_lease_for_signature` accept a row already out for signature. Scoping
   * the gate to editable rows would leave the assistant able to re-send a lease
   * whose record drifted after it went out.
   */
  it("still refuses a re-send of a lease already out for signature", async () => {
    seedConfirmedUpload();
    const confirmedParse = storedRow()!.uploadedLeaseParse!;
    const upload = storedRow()!.managerUploadedPdf;
    seedDemoManagerApplicationRows([applicationRow({ signedMonthlyRent: 1450 })], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: null,
          managerUploadedPdf: upload,
          uploadedLeaseParse: confirmedParse,
          bucket: "resident",
          status: "Resident Signature Pending",
        }),
      ],
      MANAGER_ID,
    );

    const row = storedRow()!;
    expect(leaseSendStillReachable(row)).toBe(true);
    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    // It cannot be confirmed where it stands, so the refusal names the action
    // that IS available rather than a button that is not on screen.
    expect(result.error).toMatch(/move this lease back to manager review/i);
  });

  /**
   * ...but the CTA is narrower than the gate on purpose. `confirmUploadedLeaseParse`
   * refuses a row that no longer allows document edits, so offering "Review
   * import" there would be a primary button whose action always fails and which
   * nothing on screen can clear.
   */
  it("never asks for review on a finalized lease, where confirming could not succeed", () => {
    seedConfirmedUpload();
    const confirmedParse = storedRow()!.uploadedLeaseParse!;
    const upload = storedRow()!.managerUploadedPdf;
    seedDemoManagerApplicationRows([applicationRow({ signedMonthlyRent: 1450 })], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: null,
          managerUploadedPdf: upload,
          uploadedLeaseParse: confirmedParse,
          bucket: "signed",
          status: "Fully Signed",
          residentSignature: { role: "resident", name: "Diego Morales", signedAtIso: "2026-08-05T00:00:00.000Z" },
          managerSignature: { role: "manager", name: "Pat", signedAtIso: "2026-08-06T00:00:00.000Z" },
        }),
      ],
      MANAGER_ID,
    );

    const row = storedRow()!;
    expect(leaseSendStillReachable(row)).toBe(false);
    expect(leaseNeedsUploadedLeaseReviewAction(row)).toBe(false);
    expect(leaseSendHeldByUploadedLeaseReview(row)).toBe(false);
  });

  it("treats a confirmation that names no record as not covering one", async () => {
    seedConfirmedUpload();
    const confirmedParse = storedRow()!.uploadedLeaseParse!;
    const upload = storedRow()!.managerUploadedPdf;
    // The legacy cohort: confirmed before the fingerprint field existed.
    seedDemoManagerApplicationRows([applicationRow({ signedMonthlyRent: 1450 })], MANAGER_ID);
    seedDemoLeasePipeline(
      [
        leaseRow({
          generatedHtml: null,
          managerUploadedPdf: upload,
          uploadedLeaseParse: {
            ...confirmedParse,
            review: { ...confirmedParse.review, confirmedRecordFingerprint: null },
          },
        }),
      ],
      MANAGER_ID,
    );

    // Fails closed, and does NOT claim the record changed — PropLane cannot tell.
    expect(leaseMismatchAcknowledgementGapForRow(storedRow()!)).toBe("record_unknown");
    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/record has changed since/i);
  });
});

/**
 * The email fallback exists so a lease whose row was never stamped with an Axis
 * id still finds its application. It must not invent a refusal: someone can hold
 * a pending or withdrawn application for a DIFFERENT property alongside the
 * approved one this lease came from.
 */
describe("the application lookup never manufactures a block from an unrelated row", () => {
  beforeEach(resetStores);

  it("prefers the approved, live application among several for one person", async () => {
    seedDemoManagerApplicationRows(
      [
        applicationRow({ id: "AXIS-OTHERPROP", bucket: "pending", stage: "Submitted", property: "Somewhere Else" }),
        applicationRow({ id: "AXIS-WITHDRAWN", withdrawnAt: "2026-07-01T00:00:00.000Z" }),
        applicationRow({ id: "AXIS-REAL" }),
      ],
      MANAGER_ID,
    );
    seedDemoLeasePipeline([leaseRow({ axisId: undefined, propertyId: "unmatched-property" })], MANAGER_ID);

    expect(leaseApplicationApprovalBlocker(storedRow()!)).toBeNull();
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });
});

describe("ensureManagerReviewLeaseForApplication", () => {
  beforeEach(resetStores);

  it("returns a manager-review lease for an approved manager-added resident", () => {
    seedDemoManagerApplicationRows([applicationRow({ manuallyAdded: true })], MANAGER_ID);
    seedDemoLeasePipeline([], MANAGER_ID);

    const result = ensureManagerReviewLeaseForApplication(AXIS_ID, MANAGER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.bucket).toBe("manager");
    expect(result.row.residentEmail).toBe("diego.morales@example.com");
    expect(readLeasePipeline(MANAGER_ID).some((row) => row.id === result.row.id)).toBe(true);
  });

  it("refuses pending residents", () => {
    seedDemoManagerApplicationRows([applicationRow({ bucket: "pending", stage: "Submitted" })], MANAGER_ID);
    expect(ensureManagerReviewLeaseForApplication(AXIS_ID, MANAGER_ID)).toEqual({
      ok: false,
      error: "Approve this resident before adding a lease.",
    });
  });
});
