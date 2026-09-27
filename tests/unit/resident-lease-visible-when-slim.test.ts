// @vitest-environment jsdom
/**
 * Part 3 hotfix, defect 1: the lease list is served SLIM to every reader
 * (`projectLeasePipelineListRow`, lease-pipeline-list-projection.ts) — no
 * document bytes, just `documentOmitted: true`. `residentCanViewLeaseRow`
 * used to require ACTUAL bytes (`row.generatedHtml || row.managerUploadedPdf
 * ?.dataUrl`), which the resident's own copy of a sent lease never has. Every
 * lease a manager sent was therefore invisible: the sidebar read "Lease 1"
 * while the tab read "Pending 0 · No pending leases yet." Live since Sep 19
 * (64f410ca), production included.
 */
import { describe, expect, it } from "vitest";
import { residentCanViewLeaseRow, normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { projectLeasePipelineListRow } from "@/lib/lease-pipeline-list-projection";

const FULL_ROW = normalizeLeasePipelineRow({
  id: "lease_slim_visibility",
  residentName: "Jordan Lee",
  residentEmail: "jordan.lee@example.com",
  unit: "Unit A",
  bucket: "resident",
  status: "Resident Signature Pending",
  pdfVersion: 1,
  notes: "",
  updatedAtIso: "2026-09-24T00:00:00.000Z",
  sentToResidentAt: "2026-09-24T00:00:00.000Z",
  generatedHtml: "<html><body>LEASE BODY</body></html>",
  thread: [],
});

describe("residentCanViewLeaseRow — the slim list projection", () => {
  it("is visible to the resident on the FULL row (manager's own copy)", () => {
    expect(residentCanViewLeaseRow(FULL_ROW)).toBe(true);
  });

  it("stays visible on the SLIM projection the resident's own GET actually returns", () => {
    // This is the exact shape `syncLeasePipelineFromServer` hands the resident
    // portal on a fresh browser session: no cached full copy to fall back on.
    const slim = projectLeasePipelineListRow(FULL_ROW);
    expect(slim.documentOmitted).toBe(true);
    expect(slim.generatedHtml).toBeFalsy();
    expect(residentCanViewLeaseRow(slim)).toBe(true);
  });

  it("stays invisible when the row genuinely carries no document at all", () => {
    const noDocument = normalizeLeasePipelineRow({
      ...FULL_ROW,
      generatedHtml: null,
      managerUploadedPdf: null,
    });
    expect(residentCanViewLeaseRow(noDocument)).toBe(false);
  });

  it("stays invisible before the lease has been sent, even with a document", () => {
    const draft = normalizeLeasePipelineRow({ ...FULL_ROW, bucket: "manager", status: "Manager Review" });
    expect(residentCanViewLeaseRow(draft)).toBe(false);
  });

  it("stays invisible once the manager has deleted the saved document", () => {
    const removed = normalizeLeasePipelineRow({
      ...FULL_ROW,
      leaseDocumentRemovedAt: "2026-09-24T01:00:00.000Z",
    });
    const slimRemoved = projectLeasePipelineListRow(removed);
    expect(residentCanViewLeaseRow(slimRemoved)).toBe(false);
  });

  it("is null-safe", () => {
    expect(residentCanViewLeaseRow(null)).toBe(false);
    expect(residentCanViewLeaseRow(undefined)).toBe(false);
  });
});
