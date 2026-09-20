/**
 * The early move-out fee bills ONCE when a signed lease's end date moves earlier
 * (PLAN-0920-0423). The decision is pure so it is pinned here without a database: charged
 * on an earlier date, never on an extension, never when the listing names no fee, never
 * when the manager waives it, and keyed on the lease so a second change cannot double it.
 */
import { describe, expect, it } from "vitest";
import { earlyMoveOutFeeChargeForLease, earlyMoveOutFeeForProperty } from "@/lib/lease-amendment.server";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { MockProperty } from "@/data/types";

const leaseRow = {
  id: "lease-1",
  axisId: "AXIS-1",
  residentName: "Sohan Vivek Naik",
  residentEmail: "sohan@example.com",
  residentUserId: "user-1",
  unit: "Room 2",
  propertyId: "prop-1",
  application: { leaseStart: "2026-09-21", leaseEnd: "2027-09-20" },
} as unknown as LeasePipelineRow;

function property(fee: string | undefined): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.longTermBreakLeaseFee = fee;
  return {
    id: "prop-1",
    title: "8th Ave House",
    tagline: "",
    address: "4709A 8th Ave NE, Seattle, WA 98105",
    zip: "98105",
    neighborhood: "",
    beds: 1,
    baths: 1,
    rentLabel: "",
    available: "",
    petFriendly: false,
    buildingId: "prop-1",
    buildingName: "8th Ave House",
    unitLabel: "Room 2",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  } as MockProperty;
}

const base = {
  leaseId: "lease-1",
  leaseRow,
  ownerId: "mgr-1",
  propertyId: "prop-1",
  propertyLabel: "8th Ave House",
  fee: 1455,
  newLeaseEnd: "2027-06-15",
  nowIso: "2026-12-01T00:00:00.000Z",
};

describe("earlyMoveOutFeeForProperty", () => {
  it("reads the listing's fee and treats blank or zero as none", () => {
    expect(earlyMoveOutFeeForProperty(property("1455"))).toBe(1455);
    expect(earlyMoveOutFeeForProperty(property(""))).toBeNull();
    expect(earlyMoveOutFeeForProperty(property("0"))).toBeNull();
    expect(earlyMoveOutFeeForProperty(undefined)).toBeNull();
  });
});

describe("earlyMoveOutFeeChargeForLease", () => {
  it("charges the fee once, due by the new move-out date, keyed on the lease", () => {
    const charge = earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease" });
    expect(charge).toMatchObject({
      id: "hc_mgr_emo_lease-1",
      kind: "early_move_out_fee",
      title: "Early move-out fee",
      amountLabel: "$1455.00",
      balanceLabel: "$1455.00",
      status: "pending",
      residentEmail: "sohan@example.com",
      residentUserId: "user-1",
      propertyId: "prop-1",
      managerUserId: "mgr-1",
      applicationId: "AXIS-1",
      dueDateLabel: "By Jun 15, 2027",
      blocksLeaseUntilPaid: false,
    });
    // The manager-added prefix keeps a later rebuild of the resident's charges from wiping it.
    expect(charge!.id.startsWith("hc_mgr_")).toBe(true);
  });

  it("charges nothing on an extension, a waiver, or a listing with no fee", () => {
    expect(earlyMoveOutFeeChargeForLease({ ...base, direction: "extend" })).toBeNull();
    expect(earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease", waive: true })).toBeNull();
    expect(earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease", fee: null })).toBeNull();
    expect(earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease", fee: 0 })).toBeNull();
  });

  it("yields the same id for a second earlier date, so the fee cannot double", () => {
    const first = earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease" });
    const second = earlyMoveOutFeeChargeForLease({ ...base, direction: "decrease", newLeaseEnd: "2027-05-01" });
    expect(second!.id).toBe(first!.id);
  });
});
