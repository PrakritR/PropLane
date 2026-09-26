// C064 — "Export" is a NEW, real signed-document-with-audit-page PDF action,
// distinct from the plain "Download" section action. It must:
//   - refuse (return null) on an unexecuted lease — nothing to attest yet;
//   - always end with the certificate page, for BOTH an uploaded-PDF lease
//     and a PropLane-generated (HTML) lease, which has no source PDF to
//     build on and must fall back to a real rendered body;
//   - never duplicate the certificate onto an uploaded PDF that already had
//     one merged in at signing (base off the ORIGINAL bytes, not the copy).
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildLeaseBodyTextPdf,
  htmlToPlainTextParagraphs,
} from "@/lib/lease-pdf-signing";
import {
  buildLeaseExportWithAuditPdf,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

async function createMinimalPdfDataUrl(pageCount = 1): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  const bytes = await doc.save();
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return `data:application/pdf;base64,${btoa(binary)}`;
}

function baseRow(): LeasePipelineRow {
  return {
    id: "lease-export-1",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Test unit",
    stageLabel: "Manager Review",
    updated: "now",
    bucket: "resident",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: new Date().toISOString(),
    thread: [],
  };
}

function signedRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    ...baseRow(),
    residentSignature: {
      role: "resident",
      name: "Jordan Lee",
      signedAtIso: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("buildLeaseExportWithAuditPdf", () => {
  it("refuses an unexecuted lease — nothing signed yet to attest", async () => {
    const result = await buildLeaseExportWithAuditPdf(baseRow());
    expect(result).toBeNull();
  });

  it("appends exactly one certificate page onto the ORIGINAL uploaded PDF bytes", async () => {
    const originalDataUrl = await createMinimalPdfDataUrl(2);
    const row = signedRow({
      managerUploadedPdf: {
        dataUrl: originalDataUrl,
        originalDataUrl,
        fileName: "lease.pdf",
      },
    });
    const bytes = await buildLeaseExportWithAuditPdf(row);
    expect(bytes).not.toBeNull();
    const doc = await PDFDocument.load(bytes!);
    // 2 base pages + 1 certificate page.
    expect(doc.getPageCount()).toBe(3);
  });

  it("bases the export on the ORIGINAL bytes, not a copy already merged with a certificate", async () => {
    const originalDataUrl = await createMinimalPdfDataUrl(1);
    // Simulate a row whose `.dataUrl` was already merged with a certificate
    // page at signing time (2 pages), while `.originalDataUrl` stays the
    // untouched 1-page source.
    const alreadyMergedDataUrl = await createMinimalPdfDataUrl(2);
    const row = signedRow({
      managerUploadedPdf: {
        dataUrl: alreadyMergedDataUrl,
        originalDataUrl,
        fileName: "lease.pdf",
      },
    });
    const bytes = await buildLeaseExportWithAuditPdf(row);
    const doc = await PDFDocument.load(bytes!);
    // 1 ORIGINAL page + 1 fresh certificate page — never 2 (already-merged) + 1.
    expect(doc.getPageCount()).toBe(2);
  });

  it("renders a real PDF body for a generated (HTML) lease with no source PDF", async () => {
    const row = signedRow({
      generatedHtml: "<html><body><p>Section one text.</p><p>Section two text.</p></body></html>",
    });
    const bytes = await buildLeaseExportWithAuditPdf(row);
    expect(bytes).not.toBeNull();
    const doc = await PDFDocument.load(bytes!);
    // At least one body page plus the certificate page.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("returns null for a generated lease with no document at all", async () => {
    const bytes = await buildLeaseExportWithAuditPdf(signedRow());
    expect(bytes).toBeNull();
  });
});

describe("htmlToPlainTextParagraphs", () => {
  it("strips markup and splits on block boundaries without inventing text", () => {
    const html = "<html><body><h1>Lease Agreement</h1><p>Paragraph one.</p><p>Paragraph two.</p></body></html>";
    expect(htmlToPlainTextParagraphs(html)).toEqual(["Lease Agreement", "Paragraph one.", "Paragraph two."]);
  });

  it("decodes common HTML entities", () => {
    const html = "<p>Rent &amp; fees &mdash;</p>".replace("&mdash;", "&#39;s due");
    expect(htmlToPlainTextParagraphs(html)[0]).toContain("Rent & fees");
  });

  it("drops empty paragraphs and style/script content", () => {
    const html = "<style>.a{color:red}</style><p></p><p>Real content.</p><script>alert(1)</script>";
    expect(htmlToPlainTextParagraphs(html)).toEqual(["Real content."]);
  });
});

describe("buildLeaseBodyTextPdf", () => {
  it("paginates across multiple pages for long content", async () => {
    const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph number ${i} of the lease body text.`);
    const bytes = await buildLeaseBodyTextPdf(paragraphs);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("renders a placeholder page rather than an empty PDF when there is no text", async () => {
    const bytes = await buildLeaseBodyTextPdf([]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
