// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import { buildUploadedLeaseParse, type UploadedLeaseParse } from "@/lib/uploaded-lease-extraction";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import { leaseRecordTerms } from "@/lib/lease-pipeline-storage";

const PAGES = [
  [
    "RESIDENTIAL LEASE AGREEMENT",
    "1. PARTIES",
    "This Lease is between Northgate Holdings LLC (Landlord) and Dana Reyes (Tenant).",
    "2. RENT",
    "Tenant shall pay rent of $2,400.00 per month.",
    "3. TERM",
    "Commences on March 1, 2026 and ends February 28, 2027.",
  ].join("\n"),
];

const SHA_A = "a".repeat(64);

function parsedParse(): UploadedLeaseParse {
  return buildUploadedLeaseParse({
    pages: PAGES,
    fileName: "northgate-lease.pdf",
    sourceSha256: SHA_A,
    extractedAtIso: "2026-08-01T10:00:00.000Z",
  });
}

function row(): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Dana Reyes",
    residentEmail: "dana@example.com",
    unit: "Unit 4B",
    stageLabel: "Manager review",
    updated: "today",
    bucket: "review" as LeasePipelineRow["bucket"],
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T10:00:00.000Z",
    thread: [],
    managerUploadedPdf: {
      dataUrl: "data:application/pdf;base64,JVBERi0xLjcK",
      fileName: "northgate-lease.pdf",
      uploadedAt: "2026-08-01T09:00:00.000Z",
    },
  };
}

const attestBox = () => document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-attest"]');
const confirmBtn = () => document.body.querySelector<HTMLButtonElement>('[data-attr="uploaded-lease-confirm"]');
const fieldInput = (key: string) =>
  document.body.querySelector<HTMLInputElement>(`[data-attr="uploaded-lease-field-${key}"]`);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("uploaded lease review save gate", () => {
  it("does not render a separate attestation checkbox", () => {
    render(<UploadedLeaseReviewModal open row={row()} parse={parsedParse()} onClose={() => {}} onConfirm={() => {}} />);
    expect(attestBox()).toBeNull();
  });

  it("submits the exact displayed source, revision, and record terms for confirmation", async () => {
    const onConfirm = vi.fn();
    const r = { ...row(), reviewRevision: "2026-09-24T00:00:00.000Z" };
    render(<UploadedLeaseReviewModal open row={r} parse={parsedParse()} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({
      expectedRevision: r.reviewRevision,
      viewedSourceSha256: SHA_A,
      viewedConvertedHtmlSha256: null,
      viewedRecordFingerprint: leaseRecordFingerprint(leaseRecordTerms(r)),
    });
  });

  it("keeps save disabled until required mapped terms are filled", () => {
    const sparse = buildUploadedLeaseParse({
      pages: ["Tenant shall pay rent of $2,400.00 per month."],
      fileName: "northgate-lease.pdf",
      sourceSha256: SHA_A,
      extractedAtIso: "2026-08-01T10:00:00.000Z",
    });
    render(<UploadedLeaseReviewModal open row={row()} parse={sparse} onClose={() => {}} onConfirm={() => {}} />);
    expect(confirmBtn()?.disabled).toBe(true);
    fireEvent.change(fieldInput("tenantName")!, { target: { value: "Dana Reyes" } });
    fireEvent.change(fieldInput("leaseStart")!, { target: { value: "March 1, 2026" } });
    fireEvent.change(fieldInput("leaseEnd")!, { target: { value: "February 28, 2027" } });
    fireEvent.change(fieldInput("monthlyRent")!, { target: { value: "$2,400.00" } });
    expect(confirmBtn()?.disabled).toBe(false);
  });
});
