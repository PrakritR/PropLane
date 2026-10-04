import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import {
  bidCanBeApproved,
  compareBids,
  countSubmittedBids,
  deriveAddOnStages,
  clientBidApprovalFacts,
  deriveServiceStages,
  deriveVendorRequestRows,
  serviceIsVendorPayable,
  vendorReplyChoices,
} from "@/lib/work-order-bid-cycle";
import { VENDOR_ANSWER_TABS, addOnStageFact, vendorAnswerGroup, vendorRequestFact } from "@/lib/service-lifecycle";
import { parseVisitFeeCents, isVisitFeeInvoiceNumber, visitFeeInvoiceNumber, MAX_ESTIMATE_VISIT_FEE_CENTS } from "@/lib/work-order-visit-fee";
import { invoiceBelongsInOutgoing } from "@/lib/manager-outgoing-invoices";

const row = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1",
  propertyName: "Magnolia House",
  unit: "Room 1",
  title: "Leaky faucet",
  priority: "Medium",
  status: "Open",
  bucket: "open",
  description: "",
  scheduled: "—",
  cost: "—",
  ...over,
});

const bid = (over: Partial<WorkOrderBid> = {}): WorkOrderBid => ({
  id: "bid-1",
  workOrderId: "wo-1",
  vendorUserId: "v-1",
  vendorDirectoryId: "dir-1",
  vendorName: "Rainier Plumbing",
  quoteMode: "upfront",
  consultationVisitAt: null,
  amountCents: null,
  materialsCents: 0,
  proposedTime: null,
  note: null,
  status: "submitted",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const offer = (over: Partial<WorkOrderVendorOffer> = {}): WorkOrderVendorOffer => ({
  id: "offer-1",
  workOrderId: "wo-1",
  vendorDirectoryId: "dir-9",
  vendorUserId: null,
  vendorName: "Cedar Electric",
  status: "sent",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("only a submitted bid can be approved", () => {
  it("refuses an estimate, a booked visit, and a resolved row", () => {
    expect(bidCanBeApproved({ status: "submitted", amountCents: null, bidSubmittedAt: null })).toBe(false);
    // An estimate alone: a number, but no bid price and no bid stamp.
    expect(clientBidApprovalFacts(bid({ estimateCents: 18_000 }))).toMatchObject({ amountCents: null, bidSubmittedAt: null });
    expect(bidCanBeApproved(clientBidApprovalFacts(bid({ estimateCents: 18_000 })))).toBe(false);
    expect(bidCanBeApproved(clientBidApprovalFacts(bid({ consultationVisitAt: "2026-10-05T17:00:00.000Z", quoteMode: "after_consultation" })))).toBe(false);
    expect(bidCanBeApproved({ status: "accepted", amountCents: 20_000, bidSubmittedAt: "2026-10-02T00:00:00.000Z" })).toBe(false);
    expect(bidCanBeApproved({ status: "submitted", amountCents: 0, bidSubmittedAt: "2026-10-02T00:00:00.000Z" })).toBe(false);
  });

  it("approves a priced, stamped, still-open bid", () => {
    expect(bidCanBeApproved({ status: "submitted", amountCents: 20_000, bidSubmittedAt: "2026-10-02T00:00:00.000Z" })).toBe(true);
  });

  it("reads a pre-estimate priced row as a submitted bid", () => {
    expect(bidCanBeApproved(clientBidApprovalFacts(bid({ amountCents: 15_200 })))).toBe(true);
  });
});

describe("vendor request rows (one per requested vendor)", () => {
  it("walks requested -> estimate -> visit -> bid -> approved", () => {
    const rows = deriveVendorRequestRows(
      [
        bid({ id: "a", vendorDirectoryId: "dir-a", vendorUserId: "va", estimateCents: 18_000 }),
        bid({ id: "b", vendorDirectoryId: "dir-b", vendorUserId: "vb", quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z", estimateVisitFeeCents: 4_000 }),
        bid({ id: "c", vendorDirectoryId: "dir-c", vendorUserId: "vc", quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z", estimateVisitDoneAt: "2026-10-05T18:00:00.000Z" }),
        bid({ id: "d", vendorDirectoryId: "dir-d", vendorUserId: "vd", amountCents: 15_200, materialsCents: 3_000, bidSubmittedAt: "2026-10-06T00:00:00.000Z", proposedTime: "2026-10-08T16:00:00.000Z" }),
        bid({ id: "e", vendorDirectoryId: "dir-e", vendorUserId: "ve", amountCents: 9_000, bidSubmittedAt: "2026-10-06T00:00:00.000Z", status: "accepted" }),
      ],
      [offer()],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.bidId ?? r.offerId, r]));
    expect(byId.a!.state).toBe("estimate");
    expect(byId.a!.canApprove).toBe(false);
    expect(byId.b!.state).toBe("visit_booked");
    expect(byId.b!.visitFeeCents).toBe(4_000);
    expect(byId.c!.state).toBe("visit_done");
    expect(byId.d!.state).toBe("bid");
    expect(byId.d!.canApprove).toBe(true);
    expect(byId.d!.bidTotalCents).toBe(18_200);
    expect(byId.e!.state).toBe("approved");
    expect(byId.e!.canApprove).toBe(false);
    expect(byId["offer-1"]!.state).toBe("requested");
    expect(byId["offer-1"]!.canApprove).toBe(false);
    expect(rows).toHaveLength(6);
  });

  it("hides a withdrawn offer and shows a vendor-declined one as declined", () => {
    const rows = deriveVendorRequestRows([], [offer({ id: "w", status: "withdrawn" }), offer({ id: "d", status: "declined", vendorDirectoryId: "dir-2" })]);
    expect(rows.map((r) => [r.offerId, r.state])).toEqual([["d", "declined"]]);
  });

  it("does not list a vendor twice when their offer already has a bid", () => {
    const rows = deriveVendorRequestRows([bid({ vendorDirectoryId: "dir-9" })], [offer()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offerId).toBe("offer-1");
  });
});

describe("stage derivation (server data only)", () => {
  const ids = (r: DemoManagerWorkOrderRow, bids: WorkOrderBid[] = [], offers: WorkOrderVendorOffer[] = []) =>
    deriveServiceStages(r, { bids, offers });

  it("starts Open with no vendor involved", () => {
    const { stages, currentId } = ids(row());
    expect(currentId).toBe("pending");
    expect(stages.map((s) => s.id)).toEqual(["pending", "scheduled", "completed"]);
  });

  it("is Requested once vendors are asked, with the full cycle ahead", () => {
    const { stages, currentId } = ids(row({ biddingOpen: true }), [], [offer()]);
    expect(currentId).toBe("requested");
    expect(stages.map((s) => s.label)).toEqual(["Open", "Requested", "Estimates", "Visits", "Bids", "Assigned", "Scheduled", "Completed", "Paid"]);
    expect(stages.map((s) => s.state)).toEqual(["done", "current", "todo", "todo", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("before approval the stage is how far the furthest vendor has got: estimate < visit < bid", () => {
    const base = { biddingOpen: true };
    expect(ids(row(base), [bid({ estimateCents: 18_000 })]).currentId).toBe("estimates");
    expect(ids(row(base), [bid({ estimateCents: 18_000 }), bid({ id: "b2", vendorUserId: "v-2", vendorDirectoryId: "d2", quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z" })]).currentId).toBe("visits");
    expect(
      ids(row(base), [
        bid({ id: "b2", vendorUserId: "v-2", vendorDirectoryId: "d2", quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z" }),
        bid({ id: "b3", vendorUserId: "v-3", vendorDirectoryId: "d3", amountCents: 15_000, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }),
      ]).currentId,
    ).toBe("bids");
  });

  it("is Bid approved after a bid is accepted, before the visit is booked", () => {
    const { currentId } = ids(row({ vendorId: "dir-1", vendorName: "Rainier", biddingResolvedAt: "2026-10-06T00:00:00.000Z" }), [bid({ status: "accepted", amountCents: 1 })]);
    expect(currentId).toBe("approved");
  });

  it("is Scheduled, Completed, then Paid", () => {
    const hired = { vendorId: "dir-1", vendorName: "Rainier", biddingResolvedAt: "2026-10-06T00:00:00.000Z" };
    const accepted = [bid({ status: "accepted", amountCents: 1 })];
    expect(ids(row({ ...hired, bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), accepted).currentId).toBe("scheduled");
    expect(ids(row({ ...hired, bucket: "scheduled", automationStatus: "vendor_marked_done" }), accepted).currentId).toBe("completed");
    expect(ids(row({ ...hired, bucket: "completed", automationStatus: "paid" }), accepted).currentId).toBe("paid");
  });

  it("skips the bid stages for a direct assignment and drops Paid for self or team work", () => {
    const direct = ids(row({ vendorId: "dir-1", vendorName: "Rainier", assignee: { type: "vendor", id: "dir-1", name: "Rainier" } }));
    expect(direct.stages.map((s) => s.id)).toEqual(["pending", "scheduled", "completed", "paid"]);
    const self = ids(row({ selfAssigned: true, assignee: { type: "team", id: "mgr", name: "You" } }));
    expect(self.stages.map((s) => s.id)).toEqual(["pending", "scheduled", "completed"]);
  });
});

describe("vendor answers group into the five Vendors tabs", () => {
  it("lists the tabs in order", () => {
    expect(VENDOR_ANSWER_TABS.map((t) => t.label)).toEqual(["Requested", "Estimates", "Bids", "Approved", "Declined"]);
  });
  it("puts a row under the tab its answer has reached; an estimate visit counts as an estimate", () => {
    const rows = deriveVendorRequestRows(
      [
        bid({ id: "e", vendorUserId: "a", vendorDirectoryId: "da", estimateCents: 100 }),
        bid({ id: "v", vendorUserId: "b", vendorDirectoryId: "db", quoteMode: "after_consultation", consultationVisitAt: "2026-10-05T17:00:00.000Z" }),
        bid({ id: "b", vendorUserId: "c", vendorDirectoryId: "dc", amountCents: 100, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }),
        bid({ id: "w", vendorUserId: "d", vendorDirectoryId: "dd", status: "accepted", amountCents: 100, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }),
        bid({ id: "x", vendorUserId: "f", vendorDirectoryId: "df", status: "declined" }),
      ],
      [offer({ vendorDirectoryId: "dz" })],
    );
    expect(rows.map((r) => `${r.bidId ?? r.offerId}:${vendorAnswerGroup(r.state)}`)).toEqual([
      "e:estimates",
      "v:estimates",
      "b:bids",
      "w:approved",
      "x:declined",
      "offer-1:requested",
    ]);
  });
  it("words each answer as a plain fact", () => {
    const rows = deriveVendorRequestRows(
      [
        bid({ id: "e", vendorUserId: "a", vendorDirectoryId: "da", estimateCents: 18_000, estimateGivenAt: "2026-10-03T12:00:00.000Z" }),
        bid({ id: "b", vendorUserId: "c", vendorDirectoryId: "dc", amountCents: 15_200, materialsCents: 1_200, bidSubmittedAt: "2026-10-06T00:00:00.000Z", proposedTime: "2026-10-08T16:00:00.000Z" }),
      ],
      [offer({ createdAt: "2026-10-03T12:00:00.000Z" })],
    );
    const fact = (key: string) => vendorRequestFact(rows.find((r) => (r.bidId ?? r.offerId) === key)!);
    expect(fact("e")).toMatch(/^Estimate \$180 · Oct 3$/);
    expect(fact("b")).toMatch(/^Bid \$152 \+ \$12 materials · can start \w{3}, Oct 8$/);
    expect(fact("offer-1")).toBe("Requested Oct 3 · waiting");
  });
});

describe("compareBids", () => {
  const rows = deriveVendorRequestRows(
    [
      bid({ id: "hi", vendorName: "City Fix Co.", vendorUserId: "a", vendorDirectoryId: "da", amountCents: 20_000, bidSubmittedAt: "2026-10-06T00:00:00.000Z", proposedTime: "2026-10-07T16:00:00.000Z" }),
      bid({ id: "lo", vendorName: "Rapid Pipes", vendorUserId: "b", vendorDirectoryId: "db", amountCents: 15_200, materialsCents: 1_200, bidSubmittedAt: "2026-10-06T00:00:00.000Z", proposedTime: "2026-10-08T16:00:00.000Z", quoteMode: "after_consultation", consultationVisitAt: "2026-10-06T23:00:00.000Z" }),
      bid({ id: "est", vendorUserId: "c", vendorDirectoryId: "dc", estimateCents: 9_000 }),
    ],
    [offer()],
  );
  it("sorts submitted bids by total and flags the lowest; an estimate is never compared", () => {
    const compared = compareBids(rows);
    expect(compared.map((c) => c.vendorName)).toEqual(["Rapid Pipes", "City Fix Co."]);
    expect(compared.map((c) => c.totalCents)).toEqual([16_400, 20_000]);
    expect(compared.map((c) => c.lowest)).toEqual([true, false]);
    expect(compared[0]).toMatchObject({ laborCents: 15_200, materialsCents: 1_200, earliestAt: "2026-10-08T16:00:00.000Z", estimateVisitAt: "2026-10-06T23:00:00.000Z" });
    expect(compared[1]!.estimateVisitAt).toBeNull();
  });
  it("flags every vendor tied at the lowest total, and returns nothing without a bid", () => {
    const tie = deriveVendorRequestRows(
      [
        bid({ id: "t1", vendorUserId: "a", vendorDirectoryId: "da", amountCents: 100, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }),
        bid({ id: "t2", vendorUserId: "b", vendorDirectoryId: "db", amountCents: 100, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }),
      ],
      [],
    );
    expect(compareBids(tie).map((c) => c.lowest)).toEqual([true, true]);
    expect(compareBids([])).toEqual([]);
    expect(compareBids(rows.filter((r) => r.state !== "bid"))).toEqual([]);
  });
  it("counts only submitted bids", () => {
    expect(countSubmittedBids([bid({ id: "x", amountCents: 100, bidSubmittedAt: "2026-10-06T00:00:00.000Z" }), bid({ id: "y", estimateCents: 50 })])).toBe(1);
  });
});

describe("add-on cycle", () => {
  const ids = (input: Parameters<typeof deriveAddOnStages>[0]) => deriveAddOnStages(input);
  it("is Open · Assigned · Scheduled · Completed · Paid", () => {
    expect(ids({ status: "pending" }).stages.map((s) => s.label)).toEqual(["Open", "Assigned", "Scheduled", "Completed", "Paid"]);
  });
  it("moves through the stages from the request's own data", () => {
    expect(ids({ status: "pending" }).currentId).toBe("pending");
    expect(ids({ status: "approved" }).currentId).toBe("pending");
    expect(ids({ status: "approved", assignee: { id: "m" } }).currentId).toBe("assigned");
    expect(ids({ status: "approved", assignee: { id: "m" }, proposedVisit: { iso: "2026-10-08T16:00:00.000Z" } }).currentId).toBe("scheduled");
    expect(ids({ status: "returned", assignee: { id: "m" } }).currentId).toBe("completed");
    expect(ids({ status: "returned", assignee: { id: "m" }, servicePaid: true }).currentId).toBe("paid");
    expect(ids({ status: "denied" }).stages.map((s) => s.id)).toEqual(["pending", "declined"]);
  });
  it("the Services row fact is the same stage", () => {
    expect(addOnStageFact({ status: "approved", assignee: { id: "m", name: "Jordan Lee" } })).toBe("Jordan Lee · no time yet");
    expect(addOnStageFact({ status: "pending" })).toBe("New");
    expect(addOnStageFact({ status: "denied" })).toBe("Declined");
  });
});

describe("self and team work are never payable", () => {
  it("is payable only for an assigned vendor", () => {
    expect(serviceIsVendorPayable(row({ vendorName: "Rainier", vendorId: "dir-1" }))).toBe(true);
    expect(serviceIsVendorPayable(row({ selfAssigned: true }))).toBe(false);
    expect(serviceIsVendorPayable(row({ selfAssigned: true, vendorName: "Stale" }))).toBe(false);
    expect(serviceIsVendorPayable(row({ assignee: { type: "team", id: "co", name: "Co" } }))).toBe(false);
    expect(serviceIsVendorPayable(row())).toBe(false);
  });
});

describe("vendor reply choices", () => {
  const labels = (b?: WorkOrderBid) => vendorReplyChoices(b).map((c) => c.label);
  it("offers all four on a fresh request", () => {
    expect(labels()).toEqual(["Give estimate", "Book visit", "Submit bid", "Decline"]);
  });
  it("narrows after an estimate, a booked visit, and a finished visit", () => {
    expect(labels(bid({ estimateCents: 18_000 }))).toEqual(["Submit bid", "Book visit", "Decline"]);
    expect(labels(bid({ consultationVisitAt: "2026-10-05T17:00:00.000Z" }))).toEqual(["Visit done", "Submit bid", "Decline"]);
    expect(labels(bid({ consultationVisitAt: "2026-10-05T17:00:00.000Z", estimateVisitDoneAt: "2026-10-05T18:00:00.000Z" }))).toEqual(["Submit bid", "Decline"]);
  });
});

describe("estimate visit fee primitives", () => {
  it("parses a fee in whole cents within the ceiling", () => {
    expect(parseVisitFeeCents(undefined)).toBe(0);
    expect(parseVisitFeeCents("")).toBe(0);
    expect(parseVisitFeeCents(4_000)).toBe(4_000);
    expect(parseVisitFeeCents(-1)).toBeNull();
    expect(parseVisitFeeCents(MAX_ESTIMATE_VISIT_FEE_CENTS + 1)).toBeNull();
    expect(parseVisitFeeCents("abc")).toBeNull();
  });
  it("marks a visit-fee invoice by its number and keeps it payable without a hired vendor", () => {
    expect(isVisitFeeInvoiceNumber(visitFeeInvoiceNumber("bid-1"))).toBe(true);
    expect(isVisitFeeInvoiceNumber("INV-9")).toBe(false);
    const fee = { status: "approved" as const, workOrderId: "wo-1", vendorUserId: "v-1", invoiceNumber: visitFeeInvoiceNumber("bid-1") };
    expect(invoiceBelongsInOutgoing(fee, null)).toBe(true);
    expect(invoiceBelongsInOutgoing({ ...fee, invoiceNumber: "INV-9" }, null)).toBe(false);
    expect(invoiceBelongsInOutgoing({ ...fee, invoiceNumber: "INV-9" }, "v-1")).toBe(true);
  });
});
