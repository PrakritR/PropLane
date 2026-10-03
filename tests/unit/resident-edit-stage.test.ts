import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  diffResidentEdit,
  residentEditRequiresVoidConfirm,
  residentEditSaveWill,
  resolveResidentEditStage,
  snapshotResidentEditBaseline,
} from "@/lib/resident-edit-stage";

const baseRow = (): DemoApplicantRow => ({
  id: "app-1",
  name: "Casey",
  email: "casey@example.com",
  property: "House",
  bucket: "approved",
  status: "Approved",
  manuallyAdded: false,
});

const leaseRow = (overrides: Partial<LeasePipelineRow>): LeasePipelineRow =>
  ({
    id: "lease-1",
    residentName: "Casey",
    residentEmail: "casey@example.com",
    unit: "Room 1",
    stageLabel: "Draft",
    updated: "today",
    bucket: "manager",
    pdfVersion: 1,
    status: "Draft",
    ...overrides,
  }) as LeasePipelineRow;

describe("resolveResidentEditStage", () => {
  it("marks applicant when no lease", () => {
    const r = resolveResidentEditStage({ row: baseRow(), leaseRows: [] });
    expect(r.stage).toBe("applicant");
  });

  it("marks lease_sent for signature-pending status", () => {
    const r = resolveResidentEditStage({
      row: baseRow(),
      leaseRows: [leaseRow({ status: "Resident Signature Pending", sentToResidentAt: "2026-01-01" })],
    });
    expect(r.stage).toBe("lease_sent");
  });

  it("marks signed for fully signed e-sign lease", () => {
    const r = resolveResidentEditStage({
      row: baseRow(),
      leaseRows: [
        leaseRow({
          status: "Fully Signed",
          bucket: "signed",
          residentSignature: { role: "resident", name: "Casey", signedAtIso: "2026-01-02" },
        }),
      ],
    });
    expect(r.stage).toBe("signed");
  });

  it("marks by_hand for manually added off-platform lease", () => {
    const r = resolveResidentEditStage({
      row: { ...baseRow(), manuallyAdded: true },
      leaseRows: [leaseRow({ status: "Fully Signed", externallySignedLease: true })],
    });
    expect(r.stage).toBe("by_hand");
  });
});

describe("residentEditSaveWill", () => {
  const baseline = snapshotResidentEditBaseline({
    name: "A",
    email: "a@x.com",
    phone: "",
    preferredContact: "email",
    propertyId: "p1",
    roomId: "",
    bundleId: "",
    leaseTerm: "12mo",
    moveInDate: "2026-01-01",
    moveOutDate: "",
    rent: "1000",
    utilities: "",
    moveInFee: "",
    securityDeposit: "",
    otherFeeLabel: "",
    otherFeeAmount: "",
    rentDueDay: "1",
    billingStart: "move_in",
    application: {},
  });

  it("applicant rent change mentions application terms", () => {
    const form = { ...baseline, rent: "1100", application: {} };
    const diff = diffResidentEdit(baseline, form);
    const will = residentEditSaveWill("applicant", diff);
    expect(will.some((w) => w.text.includes("Application terms"))).toBe(true);
    expect(will.some((w) => w.text.includes("No lease or charges"))).toBe(true);
  });

  it("lease_sent requires void confirm when lease terms change", () => {
    const form = { ...baseline, rent: "950", application: {} };
    const diff = diffResidentEdit(baseline, form);
    expect(residentEditRequiresVoidConfirm("lease_sent", diff)).toBe(true);
    expect(residentEditSaveWill("lease_sent", diff).some((w) => w.text.includes("voided"))).toBe(true);
  });
});
