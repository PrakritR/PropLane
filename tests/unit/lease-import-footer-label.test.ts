import { describe, expect, it } from "vitest";
import {
  leaseUploadedImportFooterLabel,
  managerLeaseSignButtonLabel,
  leaseAwaitingManagerCountersign,
  residentReturnedSignedPdfToManager,
  RESIDENT_RETURNED_SIGNED_PDF_THREAD,
} from "@/lib/lease-pipeline-storage";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

function baseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    axisId: "AXIS-1",
    residentName: "Test Resident",
    residentEmail: "resident@test.com",
    unit: "Room 1",
    propertyId: "prop-1",
    bucket: "signed",
    status: "Manager Signature Pending",
    uploadedLeaseParse: {
      status: "parsed",
      sections: [],
      fields: [],
      review: { status: "confirmed" },
    },
    residentSignature: { role: "resident", name: "Test", signedAtIso: "2026-08-01T00:00:00.000Z" },
    managerSignature: null,
    ...overrides,
  } as LeasePipelineRow;
}

describe("leaseUploadedImportFooterLabel", () => {
  it("returns Review import when review is still required", () => {
    const row = baseRow({
      bucket: "manager",
      status: "Manager Review",
      residentSignature: null,
      uploadedLeaseParse: {
        status: "parsed",
        sections: [],
        fields: [],
        review: { status: "unread" },
      },
    });
    expect(leaseUploadedImportFooterLabel(row)).toBe("Review import");
  });

  it("returns null when manager countersign should take the slot", () => {
    expect(leaseUploadedImportFooterLabel(baseRow())).toBeNull();
  });

  it("returns null when resident returned an offline-signed PDF", () => {
    const row = baseRow({
      bucket: "signed",
      residentSignature: null,
      signatureName: null,
      signedAtIso: null,
      uploadedLeaseParse: null,
      thread: [{ id: "t1", role: "resident", body: RESIDENT_RETURNED_SIGNED_PDF_THREAD, at: "Aug 1" }],
    });
    expect(leaseAwaitingManagerCountersign(row)).toBe(true);
    expect(leaseUploadedImportFooterLabel(row)).toBeNull();
  });

  it("returns View import after review when resident has not signed yet", () => {
    const row = baseRow({
      residentSignature: null,
      status: "Manager Review",
      uploadedLeaseParse: {
        status: "parsed",
        sections: [],
        fields: [],
        review: { status: "confirmed" },
      },
    });
    expect(leaseUploadedImportFooterLabel(row)).toBe("View import");
  });
});

describe("residentReturnedSignedPdfToManager", () => {
  it("reads the durable timestamp or thread marker", () => {
    expect(
      residentReturnedSignedPdfToManager(
        baseRow({ residentReturnedSignedPdfAt: "2026-08-01T00:00:00.000Z" }),
      ),
    ).toBe(true);
    expect(
      residentReturnedSignedPdfToManager(
        baseRow({
          thread: [{ id: "t1", role: "resident", body: RESIDENT_RETURNED_SIGNED_PDF_THREAD, at: "Aug 1" }],
        }),
      ),
    ).toBe(true);
  });
});

describe("managerLeaseSignButtonLabel", () => {
  it("uses Sign lease everywhere", () => {
    expect(managerLeaseSignButtonLabel()).toBe("Sign lease");
  });
});
