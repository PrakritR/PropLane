import { describe, expect, it } from "vitest";
import {
  leaseRowCarriesDocumentBytes,
  leaseRowHasDocument,
  mergeOmittedLeaseDocuments,
  projectLeasePipelineListRow,
  restoreOmittedLeaseDocument,
} from "@/lib/lease-pipeline-list-projection";

const fatPdf = `data:application/pdf;base64,${"A".repeat(8000)}`;

const stored = {
  id: "lease-1",
  generatedHtml: "<html>long lease</html>",
  managerUploadedPdf: {
    dataUrl: fatPdf,
    fileName: "Lease Heesu Room 1.pdf",
    uploadedAt: "2026-09-18T00:00:00.000Z",
  },
  documentOmitted: false,
};

describe("lease pipeline list projection", () => {
  it("recognizes short generated HTML as a stored lease document", () => {
    const shortGeneratedLease = {
      id: "lease-short-html",
      generatedHtml: "<p>Short but complete lease</p>",
      managerUploadedPdf: null,
    };

    expect(leaseRowCarriesDocumentBytes(shortGeneratedLease)).toBe(true);
    expect(leaseRowHasDocument(shortGeneratedLease)).toBe(true);
    expect(projectLeasePipelineListRow(shortGeneratedLease)).toMatchObject({
      generatedHtml: "",
      documentOmitted: true,
    });
  });

  it("strips embedded PDF and HTML bytes from the list row", () => {
    const listed = projectLeasePipelineListRow(stored);
    expect(listed.documentOmitted).toBe(true);
    expect(listed.generatedHtml).toBe("");
    expect(listed.managerUploadedPdf?.dataUrl).toBe("");
    expect(listed.managerUploadedPdf?.fileName).toBe("Lease Heesu Room 1.pdf");
    expect(leaseRowCarriesDocumentBytes(listed)).toBe(false);
    expect(leaseRowHasDocument(listed)).toBe(true);
    expect(JSON.stringify(listed).length).toBeLessThan(JSON.stringify(stored).length / 2);
  });

  it("restores stored bytes when a list-shaped write comes back", () => {
    const listed = projectLeasePipelineListRow(stored);
    const restored = restoreOmittedLeaseDocument(stored, { ...listed, notes: "keep me" });
    expect(restored.managerUploadedPdf?.dataUrl).toBe(fatPdf);
    expect(restored.documentOmitted).toBe(false);
    expect(leaseRowCarriesDocumentBytes(restored)).toBe(true);
  });

  it("keeps local bytes when the list GET omitted them", () => {
    const merged = mergeOmittedLeaseDocuments([stored], [projectLeasePipelineListRow(stored)]);
    expect(merged[0]?.managerUploadedPdf?.dataUrl).toBe(fatPdf);
  });

  it("keeps the Documents library id when the list omits bytes", () => {
    const listed = projectLeasePipelineListRow({
      ...stored,
      managerUploadedPdf: { ...stored.managerUploadedPdf, libraryDocumentId: "doc-1" },
    });
    expect(listed.managerUploadedPdf?.libraryDocumentId).toBe("doc-1");
  });

  it("does not invent a document when the stored row never had one", () => {
    const empty = { id: "lease-2", generatedHtml: null, managerUploadedPdf: null };
    expect(leaseRowHasDocument(empty)).toBe(false);
    expect(restoreOmittedLeaseDocument(empty, projectLeasePipelineListRow(empty)).managerUploadedPdf).toBeNull();
  });
});
