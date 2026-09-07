import { describe, expect, it } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseExecutionStripRefusal,
  leaseRowHasDocumentBody,
  stripsLeaseExecutionWithoutSupersede,
} from "@/lib/lease-execution-evidence";

function executedLease(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Jordan Lee",
    residentEmail: "jordan@example.com",
    unit: "Unit 1",
    stageLabel: "Signed",
    updated: "Aug 1",
    bucket: "signed",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T00:00:00.000Z",
    thread: [],
    generatedHtml: "<html><body>EXECUTED</body></html>",
    managerUploadedPdf: null,
    fullySignedAt: "2026-08-01T00:00:00.000Z",
    managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-08-01T00:00:00.000Z" },
    residentSignature: { role: "resident", name: "Jordan", signedAtIso: "2026-08-01T00:00:00.000Z" },
    status: "Fully Signed",
    ...overrides,
  };
}

describe("stripsLeaseExecutionWithoutSupersede", () => {
  it("detects stale mirror rows that erase execution and document together", () => {
    const stored = executedLease();
    const next = executedLease({
      bucket: "manager",
      status: "Draft",
      stageLabel: "Draft",
      generatedHtml: null,
      fullySignedAt: null,
      managerSignature: null,
      residentSignature: null,
    });
    expect(stripsLeaseExecutionWithoutSupersede(stored, next)).toBe(true);
    expect(leaseExecutionStripRefusal(stored, next)).toMatch(/cannot be cleared/);
  });

  it("allows renewal-shaped writes that clear signatures but carry a new document", () => {
    const stored = executedLease();
    const next = executedLease({
      bucket: "manager",
      status: "Manager Review",
      stageLabel: "Manager Review",
      generatedHtml: "<html><body>RENEWAL</body></html>",
      fullySignedAt: null,
      managerSignature: null,
      residentSignature: null,
    });
    expect(stripsLeaseExecutionWithoutSupersede(stored, next)).toBe(false);
    expect(leaseRowHasDocumentBody(next)).toBe(true);
  });

  it("does not treat execution-only rows without a document as protected", () => {
    const stored = executedLease({
      generatedHtml: null,
      managerUploadedPdf: null,
      externallySignedLease: true,
    });
    const next = executedLease({
      generatedHtml: null,
      managerUploadedPdf: null,
      externallySignedLease: false,
      fullySignedAt: null,
      managerSignature: null,
      residentSignature: null,
      status: "Manager Review",
      bucket: "manager",
    });
    expect(leaseRowHasDocumentBody(stored)).toBe(false);
    expect(stripsLeaseExecutionWithoutSupersede(stored, next)).toBe(false);
  });
});
