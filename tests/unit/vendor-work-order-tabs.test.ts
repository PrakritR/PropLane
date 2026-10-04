import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import { VENDOR_SERVICE_ACTION_LABEL, SERVICE_STAGE_TABS } from "@/lib/service-lifecycle";
import { vendorReplyChoices } from "@/lib/work-order-bid-cycle";
import { VENDOR_WORK_ORDER_LEGACY_LIST_TABS, VENDOR_WORK_ORDER_LIST_TABS, parseVendorJobDetailTab, parseVendorWorkOrderListTab, vendorJobDetailHref } from "@/lib/portal-detail-routes";
import {
  VENDOR_WORK_ORDER_TABS,
  isPricingPendingBid,
  parseVendorWorkOrderTab,
  vendorAnswerChoices,
  vendorDefaultReply,
  vendorEffectiveReply,
  vendorNextStep,
  vendorServiceFact,
  vendorServiceStage,
  vendorServiceStageItems,
} from "@/lib/vendor-work-order-tabs";

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

const VISIT = "2026-10-06T23:00:00.000Z"; // Tue, Oct 6 · 4pm Pacific
const DONE = "2026-10-06T23:30:00.000Z";

const estimateOnly = bid({ amountCents: null, proposedTime: null, estimateCents: 9_000 });
const visitBooked = bid({ amountCents: null, proposedTime: null, quoteMode: "after_consultation", consultationVisitAt: VISIT });
const visitDone = bid({ amountCents: null, proposedTime: null, quoteMode: "after_consultation", consultationVisitAt: VISIT, estimateVisitDoneAt: DONE });
const bidSent = bid({ amountCents: 15_200, materialsCents: 1_200, bidSubmittedAt: "2026-10-01T00:00:00.000Z" });
const approved = bid({ amountCents: 15_200, materialsCents: 1_200, status: "accepted" });

describe("vendor Services tabs bucket every vendor state", () => {
  it("uses the one service vocabulary", () => {
    expect(VENDOR_WORK_ORDER_TABS).toEqual(SERVICE_STAGE_TABS);
    expect(VENDOR_WORK_ORDER_TABS.map((t) => t.label)).toEqual(["Open", "Assigned", "Scheduled", "Completed"]);
  });

  it("Open: requested, estimate given, visit booked, bid submitted and waiting on the manager", () => {
    const open = row({ biddingOpen: true });
    expect(vendorServiceStage(open, undefined)).toBe("open");
    expect(vendorServiceStage(open, estimateOnly)).toBe("open");
    expect(vendorServiceStage(open, visitBooked)).toBe("open");
    expect(vendorServiceStage(open, visitDone)).toBe("open");
    expect(vendorServiceStage(open, bidSent)).toBe("open");
  });

  it("an estimate or visit still keeps the service Open even after bidding closed on the row", () => {
    expect(vendorServiceStage(row({ biddingOpen: false }), estimateOnly)).toBe("open");
  });

  it("Assigned: an approved bid or a direct assignment with no visit time", () => {
    expect(vendorServiceStage(row({ biddingOpen: true }), approved)).toBe("assigned");
    expect(vendorServiceStage(row({ vendorId: "dir-1", biddingOpen: false, vendorCostCents: 12_000 }))).toBe("assigned");
  });

  it("Scheduled: a visit time", () => {
    expect(vendorServiceStage(row({ bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), approved)).toBe("scheduled");
    expect(vendorServiceStage(row({ bucket: "scheduled", biddingOpen: false, vendorCostCents: 15_000 }))).toBe("scheduled");
  });

  it("Completed: done, invoiced, paid, or declined", () => {
    expect(vendorServiceStage(row({ bucket: "completed" }))).toBe("completed");
    expect(vendorServiceStage(row({ automationStatus: "vendor_marked_done" }))).toBe("completed");
    expect(vendorServiceStage(row({ automationStatus: "paid" }))).toBe("completed");
    expect(vendorServiceStage(row({ biddingOpen: true }), bid({ status: "declined" }))).toBe("completed");
    const declinedOffer = { id: "o1", status: "declined" } as WorkOrderVendorOffer;
    expect(vendorServiceStage(row({ biddingOpen: true }), undefined, declinedOffer)).toBe("completed");
  });

  it("isPricingPendingBid is true only after an estimate or visit without a bid", () => {
    expect(isPricingPendingBid(estimateOnly)).toBe(true);
    expect(isPricingPendingBid(visitBooked)).toBe(true);
    expect(isPricingPendingBid(bidSent)).toBe(false);
  });

  it("the stepper marks the stage and everything before it", () => {
    expect(vendorServiceStageItems("scheduled").map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);
  });
});

describe("legacy URL ids never fall home", () => {
  it("tab ids resolve onto the four tabs", () => {
    const cases: Record<string, string> = {
      pending: "open", potential: "open", quote: "open", tour: "open",
      upcoming: "scheduled", current: "scheduled", scheduled: "scheduled",
      past: "completed", completed: "completed", open: "open", assigned: "assigned",
    };
    for (const [old, stage] of Object.entries(cases)) {
      expect(parseVendorWorkOrderTab(old), old).toBe(stage);
      expect(parseVendorWorkOrderListTab(old), old).toBe(stage);
    }
    expect([...VENDOR_WORK_ORDER_LIST_TABS]).toEqual(["open", "assigned", "scheduled", "completed"]);
    for (const target of Object.values(VENDOR_WORK_ORDER_LEGACY_LIST_TABS)) expect(VENDOR_WORK_ORDER_LIST_TABS).toContain(target);
  });

  it("service page section ids keep their old aliases", () => {
    expect(parseVendorJobDetailTab("overview")).toBe("service");
    expect(parseVendorJobDetailTab("scope-photos")).toBe("service");
    expect(parseVendorJobDetailTab("bid-invoice")).toBe("invoice");
    expect(parseVendorJobDetailTab("quote")).toBe("bid");
    expect(parseVendorJobDetailTab("schedule")).toBe("schedule");
    expect(parseVendorJobDetailTab(undefined)).toBe("service");
    expect(vendorJobDetailHref("/vendor", "wo-1")).toBe("/vendor/work-orders/wo-1");
    expect(vendorJobDetailHref("/vendor", "wo-1", "bid")).toBe("/vendor/work-orders/wo-1/bid");
  });
});

describe("row facts speak the vendor vocabulary", () => {
  const open = row({ biddingOpen: true, managerName: "Taylor M.", offerExpiresAt: "2026-10-05T19:00:00.000Z" });
  it("each state", () => {
    expect(vendorServiceFact({ row: open })).toBe("Requested by Taylor M. · answer by Oct 5");
    expect(vendorServiceFact({ row: open, bid: estimateOnly })).toBe("Your estimate $90 · waiting on your bid");
    expect(vendorServiceFact({ row: open, bid: visitBooked })).toBe("Visit Tue, Oct 6 · 4pm");
    expect(vendorServiceFact({ row: open, bid: visitDone })).toBe("Visit done · waiting on your bid");
    expect(vendorServiceFact({ row: open, bid: bidSent })).toBe("Your bid $164 · waiting on the manager");
    expect(vendorServiceFact({ row: open, bid: approved })).toBe("Approved · pick a time");
    expect(vendorServiceFact({ row: row({ bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), bid: approved })).toBe("Thu, Oct 8 · 9am");
    expect(vendorServiceFact({ row: row({ bucket: "completed" }), invoiceSent: true })).toBe("Invoice sent");
    expect(vendorServiceFact({ row: row({ bucket: "completed", automationStatus: "paid", paidAt: "2026-10-02T19:00:00.000Z" }) })).toBe("Paid Oct 2");
  });

  it("never says quote, Potential or Awaiting approval", () => {
    const facts = [undefined, estimateOnly, visitBooked, visitDone, bidSent, approved].map((b) => vendorServiceFact({ row: open, bid: b }));
    for (const fact of facts) expect(fact).not.toMatch(/quote|Potential|Awaiting approval|Awaiting payment/i);
  });
});

describe("one primary next step per state", () => {
  const open = row({ biddingOpen: true });
  const step = (r: DemoManagerWorkOrderRow, b?: WorkOrderBid, extra: { invoiceSent?: boolean } = {}) => vendorNextStep({ row: r, bid: b, ...extra });

  it("Open and nothing sent -> Submit bid", () => {
    expect(step(open)).toMatchObject({ id: "submit_bid", label: "Submit bid", section: "bid" });
  });
  it("estimate given or visit done -> Submit bid; visit booked -> Visit done", () => {
    expect(step(open, estimateOnly)?.label).toBe("Submit bid");
    expect(step(open, visitDone)?.label).toBe("Submit bid");
    expect(step(open, visitBooked)).toMatchObject({ id: "visit_done", label: "Visit done" });
  });
  it("bid sent -> nothing (waiting on the manager)", () => {
    expect(step(open, bidSent)).toBeNull();
  });
  it("Assigned -> Schedule, Scheduled -> Complete", () => {
    expect(step(row({ biddingOpen: true }), approved)).toMatchObject({ id: "schedule", label: "Schedule", section: "schedule" });
    expect(step(row({ bucket: "scheduled", scheduledAtIso: VISIT }), approved)).toMatchObject({ id: "complete", label: "Complete" });
  });
  it("Completed with no invoice -> Send invoice; invoiced or paid -> nothing", () => {
    const done = row({ bucket: "completed" });
    expect(step(done)).toMatchObject({ id: "send_invoice", label: "Send invoice", section: "invoice" });
    expect(step(done, undefined, { invoiceSent: true })).toBeNull();
    expect(step(row({ bucket: "completed", automationStatus: "paid" }))).toBeNull();
  });
});

describe("reply-choice labels equal the button labels", () => {
  it("every label comes from the vendor action vocabulary", () => {
    const allowed = new Set<string>([
      VENDOR_SERVICE_ACTION_LABEL.giveEstimate,
      VENDOR_SERVICE_ACTION_LABEL.bookVisit,
      VENDOR_SERVICE_ACTION_LABEL.completeVisit,
      VENDOR_SERVICE_ACTION_LABEL.submitBid,
      VENDOR_SERVICE_ACTION_LABEL.decline,
    ]);
    for (const b of [undefined, estimateOnly, visitBooked, visitDone, bidSent]) {
      for (const choice of vendorReplyChoices(b)) expect(allowed.has(choice.label), choice.label).toBe(true);
    }
  });

  it("the submit button text is the selected choice's label, defaulting to the next step", () => {
    const offer = { id: "o1", status: "sent" } as WorkOrderVendorOffer;
    expect(vendorEffectiveReply(null, undefined, offer)?.label).toBe("Submit bid");
    expect(vendorEffectiveReply(null, visitBooked, offer)?.label).toBe("Visit done");
    expect(vendorEffectiveReply("give_estimate", undefined, offer)?.label).toBe("Give estimate");
    expect(vendorEffectiveReply("book_estimate_visit", undefined, offer)?.label).toBe("Book visit");
    expect(vendorEffectiveReply("decline", undefined, offer)?.label).toBe("Decline");
    expect(vendorDefaultReply(visitBooked)).toBe("complete_estimate_visit");
  });

  it("Decline is only offered on an open request; an existing row declines as withdraw", () => {
    expect(vendorAnswerChoices(undefined, undefined).map((c) => c.label)).toEqual(["Give estimate", "Book visit", "Submit bid"]);
    expect(vendorAnswerChoices(undefined, { id: "o1", status: "sent" } as WorkOrderVendorOffer).map((c) => c.label)).toEqual(["Give estimate", "Book visit", "Submit bid", "Decline"]);
    expect(vendorAnswerChoices(estimateOnly).map((c) => c.label)).toEqual(["Submit bid", "Book visit", "Decline"]);
  });
});
