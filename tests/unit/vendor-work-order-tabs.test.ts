import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { isPricingPendingBid, vendorWorkOrderTab } from "@/lib/vendor-work-order-tabs";

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

function bid(partial: Partial<WorkOrderBid>): WorkOrderBid {
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

describe("vendorWorkOrderTab", () => {
  it("routes open bidding to Pending", () => {
    expect(vendorWorkOrderTab(row({ biddingOpen: true }), undefined)).toBe("pending");
  });

  it("routes post-consultation pricing to Pending", () => {
    expect(
      vendorWorkOrderTab(
        row({ biddingOpen: true }),
        bid({
          quoteMode: "after_consultation",
          consultationVisitAt: "2026-07-10T15:00:00.000Z",
          amountCents: null,
          proposedTime: null,
        }),
      ),
    ).toBe("pending");
  });

  it("routes accepted fixed-price jobs to Upcoming", () => {
    expect(
      vendorWorkOrderTab(row({ bucket: "scheduled", vendorCostCents: 15_000, scheduledAtIso: "2026-07-12T10:00:00.000Z" })),
    ).toBe("upcoming");
  });

  it("routes completed jobs to Past", () => {
    expect(vendorWorkOrderTab(row({ bucket: "completed" }))).toBe("past");
  });
});

describe("isPricingPendingBid", () => {
  it("is true only after consultation without labor price", () => {
    expect(
      isPricingPendingBid(
        bid({
          quoteMode: "after_consultation",
          consultationVisitAt: "2026-07-10T15:00:00.000Z",
          amountCents: null,
          proposedTime: null,
        }),
      ),
    ).toBe(true);
    expect(isPricingPendingBid(bid({ quoteMode: "upfront", amountCents: 5000 }))).toBe(false);
  });
});
