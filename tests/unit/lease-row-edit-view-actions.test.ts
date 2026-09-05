import { describe, expect, it } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  leaseRowOpensManagerEditModal,
  leaseRowOpensManagerViewModal,
} from "@/lib/lease-pipeline-storage";

function row(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "resident@test.com",
    residentName: "Resident",
    propertyId: "prop-1",
    unit: "Unit 1",
    status: "Manager Review",
    bucket: "manager",
    generatedHtml: "<p>Lease</p>",
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
