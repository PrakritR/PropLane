// @vitest-environment jsdom
/**
 * Bug fix (night/custom-lease, coordinator-reported): a lease attached from
 * the workspace library — or any uploaded PDF — could never be sent.
 *
 * Two independent code paths both read "no document" off a row shape that
 * genuinely HAS one:
 *
 * 1. The list row's "Send" menu item (`sendLeaseToResident`) read
 *    `logical.managerUploadedPdf?.dataUrl` off the row from `readLeasePipeline()`
 *    — the LIST-shaped client cache, which intentionally omits PDF bytes for
 *    bandwidth (`documentOmitted` / `managerUploadedPdf.omitted`,
 *    `lease-pipeline-list-projection.ts`). An omitted-but-present PDF read as
 *    empty and the send was refused with "Generate or upload a lease document
 *    first." even though the server genuinely held the file.
 * 2. The lease edit modal's own Send button was gated on `editableHtml` —
 *    the GENERATED HTML body only, which a pure uploaded/library-attached PDF
 *    never has, so the button never rendered for that document type.
 *
 * Both are fixed by routing document-presence through one predicate,
 * `leasePipelineRowHasDocument` (-> `leaseRowHasDocument`), which already
 * correctly recognizes the list-omitted shape — taught into
 * `leaseSendGateBlockerAmong` itself (the send gate `sendLeaseToResident`,
 * the assistant's `send_lease_for_signature`, and `leaseCanBeSentForSignature`
 * all read), not bypassed around it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmUploadedLeaseParse,
  leaseCanBeSentForSignature,
  leasePipelineRowHasDocument,
  leaseSendGateBlocker,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  seedDemoLeasePipeline,
  sendLeaseToResident,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { buildUploadedLeaseParse } from "@/lib/uploaded-lease-extraction";

const MANAGER_ID = "manager-send-uploaded-pdf";
const ROW_ID = "lease_send_uploaded_pdf_1";

function baseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: ROW_ID,
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-09-25T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    status: "Manager Review",
    generatedHtml: null,
    ...overrides,
  });
}

/** Exactly the shape `projectLeasePipelineListRow` produces for an uploaded PDF row. */
function listProjectedPdfRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return baseRow({
    documentOmitted: true,
    managerUploadedPdf: {
      dataUrl: "",
      fileName: "lease.pdf",
      uploadedAt: "2026-09-25T00:00:00.000Z",
      omitted: true,
    },
    ...overrides,
  });
}

describe("leasePipelineRowHasDocument recognizes an uploaded PDF whether or not bytes are loaded", () => {
  it("is true for a full row carrying real PDF bytes", () => {
    const row = baseRow({
      managerUploadedPdf: {
        dataUrl: "data:application/pdf;base64,AAA",
        originalDataUrl: "data:application/pdf;base64,AAA",
        fileName: "lease.pdf",
        uploadedAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(leasePipelineRowHasDocument(row)).toBe(true);
  });

  it("is true for a LIST-projected row whose bytes were omitted for bandwidth (the bug)", () => {
    expect(leasePipelineRowHasDocument(listProjectedPdfRow())).toBe(true);
  });

  it("is false when there is genuinely no document at all", () => {
    expect(leasePipelineRowHasDocument(baseRow({ managerUploadedPdf: null }))).toBe(false);
  });
});

describe("leaseSendGateBlocker no longer refuses a library-attached / uploaded PDF lease", () => {
  it("returns null (sendable) for a list-projected uploaded-PDF row", () => {
    expect(leaseSendGateBlocker(listProjectedPdfRow())).toBeNull();
  });

  it("still refuses with the same message when there is no document at all", () => {
    expect(leaseSendGateBlocker(baseRow({ managerUploadedPdf: null }))).toBe(
      "Generate or upload a lease document first.",
    );
  });

  it("leaseCanBeSentForSignature agrees — a library-attached row reads as sendable", () => {
    expect(leaseCanBeSentForSignature(listProjectedPdfRow())).toBe(true);
  });
});

describe("sendLeaseToResident sends a lease attached from the library / an uploaded PDF, end to end", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it("succeeds for a row that has ONLY an uploaded PDF (no generatedHtml) — the library-attach shape", async () => {
    const parse = buildUploadedLeaseParse({
      pages: ["RESIDENTIAL LEASE\nTenant: Jordan Lee"],
      fileName: "night-proof-lease.pdf",
      sourceSha256: "a".repeat(64),
      extractedAtIso: "2026-09-25T00:00:00.000Z",
    });
    seedDemoLeasePipeline(
      [
        baseRow({
          managerUploadedPdf: {
            dataUrl: "data:application/pdf;base64,AAA",
            originalDataUrl: "data:application/pdf;base64,AAA",
            fileName: "night-proof-lease.pdf",
            uploadedAt: "2026-09-25T00:00:00.000Z",
            libraryDocumentId: "lib_1",
            fields: [{ id: "f1", page: 0, x: 0.1, y: 0.8, w: 0.28, h: 0.045, role: "resident", kind: "signature" }],
          },
          uploadedLeaseParse: parse,
        }),
      ],
      MANAGER_ID,
    );
    // Confirming the imported-lease review is a separate, unrelated gate
    // (`leaseAwaitsUploadedLeaseReview`) that already correctly applies to
    // every upload; satisfy it here so this test isolates the document-
    // presence bug fix specifically.
    expect(confirmUploadedLeaseParse(ROW_ID, { managerUserId: MANAGER_ID, confirmedByName: "Pat Manager" }).ok).toBe(true);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const row = readLeasePipeline(MANAGER_ID).find((r) => r.id === ROW_ID);
    expect(row?.status).toBe("Resident Signature Pending");
    expect(row?.bucket).toBe("resident");
    expect(row?.managerUploadedPdf?.libraryDocumentId).toBe("lib_1");
  });

  it("still refuses a PDF-only row with no document body", async () => {
    seedDemoLeasePipeline([baseRow({ managerUploadedPdf: null })], MANAGER_ID);

    const result = await sendLeaseToResident(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Generate or upload a lease document first.");
  });
});
