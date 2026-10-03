// @vitest-environment jsdom
/**
 * A machine-extracted contract must not be signable until a person has said it
 * is right. Delete the `leaseAwaitsUploadedLeaseReview` check in
 * `sendLeaseToResident` and the first test here goes red.
 *
 * The other half of the promise is that parsing never touches the artifact:
 * the uploaded bytes stay byte-identical through parse and confirm.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmUploadedLeaseParse,
  leaseAwaitsUploadedLeaseReview,
  readLeasePipeline,
  saveUploadedLeaseParse,
  seedDemoLeasePipeline,
  sendLeaseToResident,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  buildUploadedLeaseParse,
  failedUploadedLeaseParse,
  pendingUploadedLeaseParse,
  UNREAD_UPLOADED_LEASE_REASON,
  unreadUploadedLeaseParse,
  uploadedLeaseNeedsManagerConfirmation,
  uploadedLeaseReviewIsConfirmed,
  uploadedLeaseWasNeverRead,
} from "@/lib/uploaded-lease-extraction";
import { retryUploadedLeaseParse } from "@/lib/uploaded-lease-parse.client";
import { buildUploadedLeaseProplaneHtml } from "@/lib/uploaded-lease-proplane-format";

const MANAGER_ID = "manager-import-gate";
const ROW_ID = "lease_import_gate_1";
const ORIGINAL_PDF = "data:application/pdf;base64,JVBERi0xLjQKUFJPUExBTkVfT1JJR0lOQUw=";

function parseFixture() {
  return buildUploadedLeaseParse({
    pages: ["1. RENT\nMonthly rent is $2,150.00.", "2. TERM\nCommences on March 1, 2026."],
    fileName: "harbour-point.pdf",
    sourceSha256: "c".repeat(64),
    extractedAtIso: "2026-08-01T00:00:00.000Z",
  });
}

function uploadedRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: ROW_ID,
    residentName: "Dana Whitfield",
    residentEmail: "dana.whitfield@example.com",
    unit: "44 Alder Way · Unit 3",
    stageLabel: "Manager Review",
    updated: "Aug 1",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: null,
    managerUploadedPdf: {
      dataUrl: ORIGINAL_PDF,
      originalDataUrl: ORIGINAL_PDF,
      fileName: "harbour-point.pdf",
      uploadedAt: "2026-08-01T00:00:00.000Z",
    },
    status: "Manager Review",
    ...overrides,
  };
}

function storedRow(): LeasePipelineRow | undefined {
  return readLeasePipeline(MANAGER_ID).find((r) => r.id === ROW_ID);
}

const REQUIRED_TERM_OVERRIDES = {
  tenantName: "Dana Whitfield",
  leaseStart: "March 1, 2026",
  leaseEnd: "February 28, 2027",
  monthlyRent: "$2,150.00",
} as const;

describe("an imported lease is not signable until required terms are filled", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("refuses to send a parsed lease while required mapped terms are still empty", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/save the imported lease/i);
    expect(storedRow()?.status).toBe("Manager Review");
    expect(storedRow()?.sentToResidentAt ?? null).toBeNull();
  });

  it("holds the lease while the parse is still pending, before any text has been read", async () => {
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: pendingUploadedLeaseParse("harbour-point.pdf") })],
      MANAGER_ID,
    );

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    expect(storedRow()?.status).toBe("Manager Review");
  });

  it("keeps an unsaved reading blocked even with every required term filled: Save terms is the confirmation", async () => {
    const parse = parseFixture();
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: { ...parse, review: { ...parse.review, overrides: { ...REQUIRED_TERM_OVERRIDES } } } })],
      MANAGER_ID,
    );
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);

    // Saving (no checkbox, no attestation argument) records the confirmation.
    expect(confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" }).ok).toBe(true);
    expect(storedRow()?.uploadedLeaseParse?.review.status).toBe("confirmed");
    expect(storedRow()?.uploadedLeaseParse?.review.confirmedDocumentSha256).toBe("c".repeat(64));
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);
  });

  it("still blocks a saved reading when a required term is missing", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    expect(
      confirmUploadedLeaseParse(ROW_ID, {
        managerUserId: MANAGER_ID,
        confirmedByName: "Pat Manager",
        overrides: { tenantName: "Dana Whitfield", leaseStart: "March 1, 2026" },
      }).ok,
    ).toBe(true);
    expect(uploadedLeaseNeedsManagerConfirmation(storedRow()!.uploadedLeaseParse)).toBe(false);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
  });

  it("sends once a manager has confirmed", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);

    const confirmed = confirmUploadedLeaseParse(ROW_ID, {
      managerUserId: MANAGER_ID,
      confirmedByName: "Pat Manager",
      overrides: { ...REQUIRED_TERM_OVERRIDES, securityDeposit: "$3,000.00" },
      note: "Checked against the PDF.",
    });
    expect(confirmed.ok).toBe(true);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(true);
    expect(storedRow()?.status).toBe("Resident Signature Pending");
  });

  it("records who confirmed and which values a human supplied", () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);

    confirmUploadedLeaseParse(ROW_ID, {
      managerUserId: MANAGER_ID,
      confirmedByName: "Pat Manager",
      overrides: { securityDeposit: "$3,000.00", lateFee: "   " },
    });

    const review = storedRow()?.uploadedLeaseParse?.review;
    expect(review?.status).toBe("confirmed");
    expect(review?.confirmedByName).toBe("Pat Manager");
    expect(review?.confirmedByUserId).toBe(MANAGER_ID);
    expect(review?.confirmedAtIso).toBeTruthy();
    // Blank overrides are not stored: an empty box is not a human decision.
    expect(review?.overrides).toEqual({ securityDeposit: "$3,000.00" });
  });

  /**
   * An upload with no stored reading is the LEAST reviewed document there is,
   * and it is the state every legacy and seeded upload is in. It used to be
   * exempt: Send → preview → "Send lease & notification" released it with no
   * review step, no attestation and no confirmation of its terms.
   */
  it("holds an uploaded lease that was never read, rather than exempting it", async () => {
    seedDemoLeasePipeline([uploadedRow()], MANAGER_ID);

    const parse = storedRow()!.uploadedLeaseParse;
    // The absence is made explicit rather than meaning "signable", so the
    // review modal has something to render instead of stranding the row.
    expect(uploadedLeaseWasNeverRead(parse)).toBe(true);
    expect(parse?.sourceFileName).toBe("harbour-point.pdf");
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/save the imported lease/i);
    expect(storedRow()?.status).toBe("Manager Review");
    expect(storedRow()?.sentToResidentAt ?? null).toBeNull();
  });

  it("sends a never-read upload once a manager attests to it, so the gate is not a dead end", async () => {
    seedDemoLeasePipeline([uploadedRow()], MANAGER_ID);

    expect(
      confirmUploadedLeaseParse(ROW_ID, {
        managerUserId: MANAGER_ID,
        confirmedByName: "Pat Manager",
        overrides: { ...REQUIRED_TERM_OVERRIDES },
      }).ok,
    ).toBe(true);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);

    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
    expect(storedRow()?.status).toBe("Resident Signature Pending");
  });

  /**
   * `uploadedLeaseWasNeverRead` recognises the state by this exact string, and
   * normalize PERSISTS it into `row_data` for every legacy upload. Reword the
   * constant and every already-stored row reclassifies as "could not be
   * structured" — the wrong diagnosis the never-read branch exists to avoid,
   * sending managers to look for a problem with a file PropLane never opened.
   * Change the wording only with a migration for the rows already carrying it.
   */
  it("pins the never-read marker, which is persisted into stored rows", () => {
    expect(UNREAD_UPLOADED_LEASE_REASON).toBe(
      "PropLane has no reading of this document. It was uploaded before import parsing existed, or the read never ran.",
    );
    expect(uploadedLeaseWasNeverRead(unreadUploadedLeaseParse("x.pdf"))).toBe(true);
    expect(uploadedLeaseWasNeverRead(failedUploadedLeaseParse("x.pdf", "Image-only PDF."))).toBe(false);
  });

  it("leaves an off-platform filing alone — it is executed evidence, not a document to send", () => {
    seedDemoLeasePipeline(
      [
        uploadedRow({
          externallySignedLease: true,
          bucket: "signed",
          residentSignature: { role: "resident", name: "Dana Whitfield", signedAtIso: "2026-07-01T00:00:00.000Z" },
          managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-01T00:00:00.000Z" },
        }),
      ],
      MANAGER_ID,
    );

    expect(storedRow()?.uploadedLeaseParse ?? null).toBeNull();
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);
  });

  it("leaves a natively generated lease behaving exactly as before", async () => {
    seedDemoLeasePipeline(
      [uploadedRow({ managerUploadedPdf: null, generatedHtml: "<html><body>NATIVE LEASE</body></html>" })],
      MANAGER_ID,
    );

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(true);
    expect(storedRow()?.generatedHtml).toContain("NATIVE LEASE");
  });
});

describe("parsing never touches the uploaded artifact", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("keeps the original bytes byte-identical through parse and confirm", () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: pendingUploadedLeaseParse("harbour-point.pdf") })], MANAGER_ID);

    expect(saveUploadedLeaseParse(ROW_ID, parseFixture(), MANAGER_ID).ok).toBe(true);
    expect(storedRow()?.managerUploadedPdf?.originalDataUrl).toBe(ORIGINAL_PDF);

    confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" });
    expect(storedRow()?.managerUploadedPdf?.originalDataUrl).toBe(ORIGINAL_PDF);
    expect(storedRow()?.managerUploadedPdf?.dataUrl).toBe(ORIGINAL_PDF);
    expect(storedRow()?.managerUploadedPdf?.fileName).toBe("harbour-point.pdf");
  });

  it("refuses a late parse that would overwrite a review a human already confirmed", () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" });

    const late = saveUploadedLeaseParse(ROW_ID, parseFixture(), MANAGER_ID);

    expect(late.ok).toBe(false);
    expect(storedRow()?.uploadedLeaseParse?.review.status).toBe("confirmed");
  });

  it("refuses to store a parse onto a lease that already carries a signature", () => {
    seedDemoLeasePipeline(
      [
        uploadedRow({
          uploadedLeaseParse: pendingUploadedLeaseParse("harbour-point.pdf"),
          bucket: "signed",
          residentSignature: { role: "resident", name: "Dana Whitfield", signedAtIso: "2026-08-02T00:00:00.000Z" },
        }),
      ],
      MANAGER_ID,
    );

    expect(saveUploadedLeaseParse(ROW_ID, parseFixture(), MANAGER_ID).ok).toBe(false);
  });
});

/**
 * A confirmation says WHO and WHEN; without WHAT it was a confirmation OF, a
 * manager's attestation against one document silently authorizes signing
 * another. The digest binding is what makes it specific, and a `pending` parse
 * must never be a one-way door — both are pinned here.
 */
describe("a confirmation is bound to the document it was made against", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("stamps the reviewed document's digest at confirm time", () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);

    confirmUploadedLeaseParse(ROW_ID, {
      managerUserId: MANAGER_ID,
      confirmedByName: "Pat Manager",
      overrides: { ...REQUIRED_TERM_OVERRIDES },
    });

    expect(storedRow()?.uploadedLeaseParse?.review.confirmedDocumentSha256).toBe("c".repeat(64));
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);
  });

  it("reverts to needs-review when the parse it confirmed describes different bytes", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    confirmUploadedLeaseParse(ROW_ID, {
      managerUserId: MANAGER_ID,
      confirmedByName: "Pat Manager",
      overrides: { ...REQUIRED_TERM_OVERRIDES },
    });

    const confirmed = storedRow()!.uploadedLeaseParse!;
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: { ...confirmed, sourceSha256: "e".repeat(64) } })],
      MANAGER_ID,
    );

    expect(storedRow()?.uploadedLeaseParse?.review.status).toBe("confirmed");
    expect(uploadedLeaseNeedsManagerConfirmation(storedRow()!.uploadedLeaseParse)).toBe(true);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
  });

  it("does not let a confirmation that names no document unblock signing", async () => {
    seedDemoLeasePipeline(
      [
        uploadedRow({
          uploadedLeaseParse: {
            ...parseFixture(),
            review: { status: "confirmed", confirmedByName: "Forged" },
          },
        }),
      ],
      MANAGER_ID,
    );

    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
    expect(storedRow()?.status).toBe("Manager Review");
  });

  it("keeps a digest-less parse confirmable, so it is never a dead end", async () => {
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: failedUploadedLeaseParse("harbour-point.pdf", "Image-only PDF.") })],
      MANAGER_ID,
    );

    expect(
      confirmUploadedLeaseParse(ROW_ID, {
        managerUserId: MANAGER_ID,
        confirmedByName: "Pat Manager",
        overrides: { ...REQUIRED_TERM_OVERRIDES },
      }).ok,
    ).toBe(true);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(true);
  });

  /**
   * A lease the gate is holding must never read as confirmed anywhere. Every
   * surface asks one predicate; a second, weaker rule at a call site produces a
   * lease that is unsendable AND un-confirmable behind a banner claiming it is
   * ready, which the manager cannot diagnose.
   */
  it("reads as needs-review at every surface when the confirmation no longer binds", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" });
    const confirmed = storedRow()!.uploadedLeaseParse!;
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: { ...confirmed, sourceSha256: "e".repeat(64) } })],
      MANAGER_ID,
    );
    const drifted = storedRow()!.uploadedLeaseParse!;

    // The raw status still says confirmed — which is exactly why no surface
    // may read it directly.
    expect(drifted.review.status).toBe("confirmed");
    expect(uploadedLeaseReviewIsConfirmed(drifted)).toBe(false);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
    // The rendered document agrees with the gate rather than contradicting it.
    expect(buildUploadedLeaseProplaneHtml({ parse: drifted })).toContain("Awaiting manager review");
    // And a re-read is still reachable, so the row is not a dead end.
    expect(saveUploadedLeaseParse(ROW_ID, parseFixture(), MANAGER_ID).ok).toBe(true);
  });
});

/**
 * The reading is DERIVED from one upload, so it may never outlive that upload
 * nor claim more than the stored blob can support. Both failures are silent in
 * the UI — a lease held against a document that is gone, or a renderer handed a
 * field it cannot draw — so they are pinned here.
 */
describe("a stored reading cannot outlive or misrepresent its document", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("drops the reading when the upload it describes is replaced by generated HTML", () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: parseFixture() })], MANAGER_ID);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);

    // What every regenerate path writes: generated document in, upload out.
    expect(
      updateLeasePipelineRow(
        ROW_ID,
        { generatedHtml: "<html><body>REGENERATED</body></html>", managerUploadedPdf: null },
        MANAGER_ID,
      ),
    ).toBe(true);

    // Not held against a PDF the row no longer has, and no review modal with
    // nothing behind it.
    expect(storedRow()?.uploadedLeaseParse ?? null).toBeNull();
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(false);
  });

  it("holds the lease when the stored reading cannot be interpreted", async () => {
    seedDemoLeasePipeline(
      [uploadedRow({ uploadedLeaseParse: { ...parseFixture(), version: 99 } as never })],
      MANAGER_ID,
    );

    const parse = storedRow()?.uploadedLeaseParse;
    // Fails CLOSED: kept as a parse that needs review, never dropped to null.
    expect(parse).toBeTruthy();
    expect(parse?.status).toBe("failed");
    expect(parse?.sections).toEqual([]);
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
    expect((await sendLeaseToResident(ROW_ID, MANAGER_ID)).ok).toBe(false);
  });

  it("ignores a confirmation claimed by a reading it cannot interpret", () => {
    seedDemoLeasePipeline(
      [
        uploadedRow({
          uploadedLeaseParse: {
            ...parseFixture(),
            version: 2,
            review: { status: "confirmed", confirmedByName: "Nobody" },
          } as never,
        }),
      ],
      MANAGER_ID,
    );

    expect(storedRow()?.uploadedLeaseParse?.review.status).toBe("needs_review");
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
  });

  it("survives a malformed stored reading and still renders", () => {
    seedDemoLeasePipeline(
      [
        uploadedRow({
          uploadedLeaseParse: {
            version: 1,
            status: "parsed",
            sourceFileName: "harbour-point.pdf",
            sections: [{ page: 2 }, "not a section", { title: "RENT", body: "Rent is $2,150.00." }],
            fields: [
              { key: "monthlyRent", status: "totally-made-up" },
              { key: "not-a-field", status: "extracted", value: "x" },
              { key: "securityDeposit" },
            ],
            review: { status: "needs_review" },
          } as never,
        }),
      ],
      MANAGER_ID,
    );

    const parse = storedRow()!.uploadedLeaseParse!;
    expect(parse.sections).toHaveLength(2);
    expect(parse.sections.map((s) => s.title)).toEqual(["", "RENT"]);
    expect(parse.sections.every((s) => typeof s.body === "string")).toBe(true);
    // An unknown status reads as not_found — blank and flagged, never a term —
    // and a term the blob lost is still listed rather than silently absent.
    expect(parse.fields).toHaveLength(9);
    expect(parse.fields.every((f) => f.status === "not_found" && f.value === "")).toBe(true);
    expect(parse.fields.map((f) => f.key)).toContain("securityDeposit");
    expect(parse.fields.map((f) => f.key)).not.toContain("not-a-field");
    expect(parse.fields.every((f) => Array.isArray(f.candidates))).toBe(true);

    expect(() =>
      buildUploadedLeaseProplaneHtml({ parse, placement: { residentName: "Dana Whitfield" } }),
    ).not.toThrow();
  });
});

/**
 * `pending` is written before any text is read, so a manager who closed the tab
 * mid-read owns a lease that can never be sent. Re-reading the bytes the row
 * already holds is the way out — and it must not hand out a confirmation.
 */
describe("an unread import can be read again from the bytes already on the row", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
  });

  function stubParseRoute(parse: unknown) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/portal/parse-uploaded-lease")) {
        return new Response(JSON.stringify({ parse }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("re-reads a stranded pending parse and leaves it unconfirmed", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: pendingUploadedLeaseParse("harbour-point.pdf") })], MANAGER_ID);
    const fetchMock = stubParseRoute(parseFixture());

    const result = await retryUploadedLeaseParse(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(true);
    const posted = fetchMock.mock.calls.find(([url]) => String(url).includes("parse-uploaded-lease"));
    // Re-read from the stored bytes — never a re-upload.
    expect(JSON.parse(String((posted?.[1] as RequestInit).body)).dataUrl).toBe(ORIGINAL_PDF);

    const stored = storedRow()!;
    expect(stored.uploadedLeaseParse?.status).toBe("parsed");
    expect(stored.uploadedLeaseParse?.sections.length).toBeGreaterThan(0);
    // Reading is not confirming: the human step is still required.
    expect(stored.uploadedLeaseParse?.review.status).toBe("needs_review");
    expect(leaseAwaitsUploadedLeaseReview(stored)).toBe(true);
    expect(stored.managerUploadedPdf?.originalDataUrl).toBe(ORIGINAL_PDF);
  });

  it("records a still-unreadable document as failed rather than releasing the lease", async () => {
    seedDemoLeasePipeline([uploadedRow({ uploadedLeaseParse: pendingUploadedLeaseParse("harbour-point.pdf") })], MANAGER_ID);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/portal/parse-uploaded-lease")
          ? new Response(JSON.stringify({ error: "No text could be read from this PDF." }), { status: 422 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    );

    expect((await retryUploadedLeaseParse(ROW_ID, MANAGER_ID)).ok).toBe(true);

    expect(storedRow()?.uploadedLeaseParse?.status).toBe("failed");
    expect(leaseAwaitsUploadedLeaseReview(storedRow()!)).toBe(true);
  });

  it("refuses to re-read a lease with no uploaded document", async () => {
    seedDemoLeasePipeline([uploadedRow({ managerUploadedPdf: null, generatedHtml: "<html>x</html>" })], MANAGER_ID);
    stubParseRoute(parseFixture());

    const result = await retryUploadedLeaseParse(ROW_ID, MANAGER_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no uploaded lease document/i);
  });
});
