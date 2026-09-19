import { describe, expect, it } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseRowOpensManagerEditModal,
  leaseRowOpensManagerViewModal,
} from "@/lib/lease-pipeline-storage";

const GENERATED_LEASE_HTML = `<p>${"Lease document body. ".repeat(240)}</p>`;

function row(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "resident@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    unit: "Unit 1",
    status: "Manager Review",
    bucket: "manager",
    // Document presence deliberately distinguishes embedded bytes from the
    // short metadata/list projection. Use a realistic payload here so these
    // action tests exercise the document-present branch.
    generatedHtml: GENERATED_LEASE_HTML,
    ...overrides,
  } as LeasePipelineRow;
}

describe("leaseRowOpensManagerEditModal / leaseRowOpensManagerViewModal", () => {
  it("allows edit in manager review with a generated document", () => {
    const lease = row();
    expect(leaseRowOpensManagerEditModal(lease)).toBe(true);
    expect(leaseRowOpensManagerViewModal(lease)).toBe(false);
  });

  it("offers view-only once the lease is out for resident signature", () => {
    const lease = row({
      status: "Resident Signature Pending",
      bucket: "resident",
    });
    expect(leaseRowOpensManagerEditModal(lease)).toBe(false);
    expect(leaseRowOpensManagerViewModal(lease)).toBe(true);
  });

  it("offers view-only while waiting on manager signature", () => {
    const lease = row({
      status: "Manager Signature Pending",
      bucket: "manager",
      residentSignature: { name: "Resident", signedAtIso: "2026-09-05T00:00:00.000Z" },
    });
    expect(leaseRowOpensManagerEditModal(lease)).toBe(false);
    expect(leaseRowOpensManagerViewModal(lease)).toBe(true);
  });
});
