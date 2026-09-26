import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { isInvitedJob } from "@/components/portal/vendor-jobs-panel";

function row(partial: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "Test",
    unit: "1A",
    title: "Fix sink",
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: "",
    scheduled: "",
    cost: "",
    ...partial,
  };
}

function bid(partial: Partial<WorkOrderBid> = {}): WorkOrderBid {
  return {
    id: "bid-1",
    workOrderId: "wo-1",
    vendorUserId: "v-1",
    vendorDirectoryId: "dir-1",
    quoteMode: "upfront",
    consultationVisitAt: null,
    amountCents: 10_000,
    materialsCents: 0,
    proposedTime: "2026-08-01T12:00:00.000Z",
    note: null,
    status: "submitted",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

describe("isInvitedJob", () => {
  it("is true for a job the manager opened for bidding, with no bid yet", () => {
    expect(isInvitedJob(row({ biddingOpen: true }), undefined)).toBe(true);
  });

  it("stays true while the vendor's own bid is only submitted", () => {
    expect(isInvitedJob(row({ biddingOpen: true }), bid({ status: "submitted" }))).toBe(true);
  });

  it("is false once the manager accepts or declines the bid", () => {
    expect(isInvitedJob(row({ biddingOpen: true }), bid({ status: "accepted" }))).toBe(false);
    expect(isInvitedJob(row({ biddingOpen: true }), bid({ status: "declined" }))).toBe(false);
  });

  it("is false for a job never opened for bidding", () => {
    expect(isInvitedJob(row({ biddingOpen: false }), undefined)).toBe(false);
  });
});
