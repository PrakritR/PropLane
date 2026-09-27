// @vitest-environment jsdom
/**
 * The stamped copy (night/custom-lease, item 3) is a DERIVED artifact: it
 * must never change what either party's signature hashes (that stays the
 * ORIGINAL uploaded bytes, per `lease-execution-evidence.ts`), and it must
 * carry its own, separate hash. These tests fail if that boundary blurs.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { LEASE_ESIGN_CONSENT_VERSION } from "@/lib/lease-execution-evidence";
import {
  managerSignLease,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  residentSignLease,
  seedDemoLeasePipeline,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import type { LeaseDocumentField } from "@/lib/lease-document-library";

const MANAGER_ID = "manager-field-evidence";

function independentSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function buildOnePagePdfDataUrl(): Promise<{ dataUrl: string; bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("LEASE AGREEMENT", { x: 50, y: 700, size: 14, font });
  const bytes = await doc.save();
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return { dataUrl: `data:application/pdf;base64,${btoa(binary)}`, bytes };
}

const FIELD: LeaseDocumentField = { id: "f1", page: 0, x: 0.1, y: 0.85, w: 0.3, h: 0.05, role: "resident", kind: "signature" };
const MANAGER_FIELD: LeaseDocumentField = { id: "f2", page: 0, x: 0.5, y: 0.85, w: 0.3, h: 0.05, role: "manager", kind: "signature" };

function baseRow(originalDataUrl: string, overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: "lease_field_evidence",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-07-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: null,
    managerUploadedPdf: {
      dataUrl: originalDataUrl,
      originalDataUrl,
      fileName: "lease.pdf",
      uploadedAt: "2026-07-01T00:00:00.000Z",
      fields: [FIELD, MANAGER_FIELD],
    },
    ...overrides,
  });
}

describe("signing computes a separate, derived stamped copy", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });

  const RESIDENT_SCOPE = "";

  it("hashes the resident's SIGNATURE evidence over the original bytes, unaffected by placed fields", async () => {
    const { dataUrl, bytes } = await buildOnePagePdfDataUrl();
    const expectedOriginalHash = independentSha256(bytes);
    seedDemoLeasePipeline(
      [baseRow(dataUrl, { bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-07-01T00:00:00.000Z" })],
      RESIDENT_SCOPE,
    );

    expect(await residentSignLease("jordan.lee@example.com", "Jordan Lee", LEASE_ESIGN_CONSENT_VERSION)).toEqual({ ok: true });

    const row = readLeasePipeline().find((r) => r.id === "lease_field_evidence")!;
    // The evidence hash is over the ORIGINAL bytes — never the stamped copy.
    expect(row.residentSignature?.documentSha256).toBe(expectedOriginalHash);
    expect(row.documentSha256).toBe(expectedOriginalHash);
  });

  it("produces a stamped copy with its OWN, different hash once a field has a value", async () => {
    const { dataUrl, bytes } = await buildOnePagePdfDataUrl();
    const originalHash = independentSha256(bytes);
    seedDemoLeasePipeline(
      [baseRow(dataUrl, { bucket: "resident", status: "Resident Signature Pending", sentToResidentAt: "2026-07-01T00:00:00.000Z" })],
      RESIDENT_SCOPE,
    );

    expect(await residentSignLease("jordan.lee@example.com", "Jordan Lee", LEASE_ESIGN_CONSENT_VERSION)).toEqual({ ok: true });

    const row = readLeasePipeline().find((r) => r.id === "lease_field_evidence")!;
    expect(row.managerUploadedPdf?.stampedDataUrl).toBeTruthy();
    expect(row.managerUploadedPdf?.stampedDocumentSha256).toBeTruthy();
    // Its own trail, never equal to the evidence hash of the original — a
    // stamped rendering is a different set of bytes from the agreement itself.
    expect(row.managerUploadedPdf?.stampedDocumentSha256).not.toBe(originalHash);
    expect(row.managerUploadedPdf?.stampedDocumentSha256).not.toBe(row.documentSha256);
    // The ORIGINAL bytes are untouched — still what a party would re-hash to verify.
    expect(row.managerUploadedPdf?.originalDataUrl).toBe(dataUrl);
  });

  it("gains the manager's stamp on countersignature without disturbing the resident's evidence hash", async () => {
    const { dataUrl, bytes } = await buildOnePagePdfDataUrl();
    const originalHash = independentSha256(bytes);
    seedDemoLeasePipeline(
      [
        baseRow(dataUrl, {
          bucket: "resident",
          status: "Resident Signature Pending",
          sentToResidentAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      RESIDENT_SCOPE,
    );
    await residentSignLease("jordan.lee@example.com", "Jordan Lee", LEASE_ESIGN_CONSENT_VERSION);
    const afterResident = readLeasePipeline().find((r) => r.id === "lease_field_evidence")!;
    const residentOnlyStamp = afterResident.managerUploadedPdf?.stampedDocumentSha256;

    seedDemoLeasePipeline([{ ...afterResident, bucket: "signed", status: "Manager Signature Pending" }], MANAGER_ID);
    expect(await managerSignLease("lease_field_evidence", "Pat Manager", MANAGER_ID, LEASE_ESIGN_CONSENT_VERSION)).toEqual({ ok: true });

    const fully = readLeasePipeline(MANAGER_ID).find((r) => r.id === "lease_field_evidence")!;
    expect(fully.status).toBe("Fully Signed");
    // The execution evidence hash is unchanged by the stamping/countersign step.
    expect(fully.residentSignature?.documentSha256).toBe(originalHash);
    // The stamped copy re-renders and now differs (manager's field is filled).
    expect(fully.managerUploadedPdf?.stampedDocumentSha256).toBeTruthy();
    expect(fully.managerUploadedPdf?.stampedDocumentSha256).not.toBe(residentOnlyStamp);
  });

  it("leaves the stamped copy absent when no fields were placed (today's behavior unchanged)", async () => {
    const { dataUrl } = await buildOnePagePdfDataUrl();
    seedDemoLeasePipeline(
      [
        baseRow(dataUrl, {
          bucket: "resident",
          status: "Resident Signature Pending",
          sentToResidentAt: "2026-07-01T00:00:00.000Z",
          managerUploadedPdf: {
            dataUrl,
            originalDataUrl: dataUrl,
            fileName: "lease.pdf",
            uploadedAt: "2026-07-01T00:00:00.000Z",
          },
        }),
      ],
      RESIDENT_SCOPE,
    );

    expect(await residentSignLease("jordan.lee@example.com", "Jordan Lee", LEASE_ESIGN_CONSENT_VERSION)).toEqual({ ok: true });
    const row = readLeasePipeline().find((r) => r.id === "lease_field_evidence")!;
    expect(row.managerUploadedPdf?.stampedDataUrl).toBeFalsy();
    expect(row.managerUploadedPdf?.stampedDocumentSha256).toBeFalsy();
  });
});
