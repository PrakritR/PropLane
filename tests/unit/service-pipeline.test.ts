import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";
import {
  MAX_VENDORS_PER_JOB_SEND,
  PIPELINE_TABS,
  PIPELINE_TAB_LABEL,
  buildServicePipeline,
  defaultPipelineTab,
  pipelineJobFact,
  sendBarState,
} from "@/lib/service-pipeline";

/**
 * The Vendors section of a service is ONE pipeline for both models: Available - Sent - Bids - Scheduled -
 * Done. These pin the bucketing from the offers, bids and job row (docs/agents/services-system.md).
 */
const job = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Burst pipe", priority: "Medium", status: "Open", bucket: "open",
  description: "", scheduled: "", cost: "", ...over,
});
const offer = (over: Partial<WorkOrderVendorOffer> = {}): WorkOrderVendorOffer => ({
  id: "o1", workOrderId: "wo-1", vendorDirectoryId: "d1", vendorUserId: "u1", vendorName: "Pacific Plumbing", status: "sent",
  createdAt: "2026-10-01T00:00:00.000Z", ...over,
});
const bid = (over: Partial<WorkOrderBid> = {}): WorkOrderBid => ({
  id: "b1", workOrderId: "wo-1", vendorUserId: "u1", vendorDirectoryId: "d1", vendorName: "Pacific Plumbing", quoteMode: "upfront",
  consultationVisitAt: null, amountCents: 42_000, materialsCents: 8_000, proposedTime: "2026-10-08T16:00:00.000Z", note: null,
  status: "submitted", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z",
  ...over,
});
const roster = [
  { id: "d1", name: "Pacific Plumbing", trade: "Plumbing", active: true },
  { id: "d2", name: "Cascade Drains", trade: "Plumbing", active: true },
  { id: "d3", name: "Bright Sparks", trade: "Electrical", active: true },
  { id: "d4", name: "Old Pipes", trade: "Plumbing", active: false },
];

describe("the pipeline's tabs", () => {
  it("are Available, Sent, Bids, Scheduled, Done, in that order", () => {
    expect(PIPELINE_TABS.map((id) => PIPELINE_TAB_LABEL[id])).toEqual(["Available", "Sent", "Bids", "Scheduled", "Done"]);
  });
});

describe("Available", () => {
  it("is the roster vendors who match the trade and have not been offered the job, active only", () => {
    const pipeline = buildServicePipeline({ job: job(), offers: [offer()], bids: [], roster, jobTrade: "Plumbing" });
    expect(pipeline.available.map((v) => v.id)).toEqual(["d2"]);
    expect(pipeline.counts.available).toBe(1);
    expect(pipeline.availableIsUnfiltered).toBe(false);
  });

  it("falls back to the whole active roster when nobody matches the trade, so it is never an empty dead end", () => {
    const pipeline = buildServicePipeline({ job: job(), offers: [], bids: [], roster, jobTrade: "Roofing" });
    expect(pipeline.available.map((v) => v.id)).toEqual(["d3", "d2", "d1"]);
    expect(pipeline.availableIsUnfiltered).toBe(true);
  });

  it("offers a vendor again after their offer was withdrawn", () => {
    const pipeline = buildServicePipeline({ job: job(), offers: [offer({ status: "withdrawn" })], bids: [], roster, jobTrade: "Plumbing" });
    expect(pipeline.available.map((v) => v.id)).toContain("d1");
  });
});

describe("Sent and Bids", () => {
  it("Sent holds an open offer, an estimate and a vendor who declined; Bids holds only a submitted bid", () => {
    const offers = [
      offer({ id: "o1", vendorDirectoryId: "d1", vendorUserId: "u1" }),
      offer({ id: "o2", vendorDirectoryId: "d2", vendorUserId: "u2", vendorName: "Cascade Drains" }),
      offer({ id: "o3", vendorDirectoryId: "d5", vendorUserId: "u5", vendorName: "Harborview", status: "declined", declinedReason: "Booked" }),
      offer({ id: "o4", vendorDirectoryId: "d6", vendorUserId: "u6", vendorName: "Waiting Co" }),
    ];
    const bids = [
      bid(),
      bid({ id: "b2", vendorUserId: "u2", vendorDirectoryId: "d2", vendorName: "Cascade Drains", amountCents: null, materialsCents: 0, proposedTime: null, bidSubmittedAt: null, estimateCents: 30_000 }),
    ];
    const pipeline = buildServicePipeline({ job: job({ biddingOpen: true }), offers, bids, roster, jobTrade: "Plumbing" });
    expect(pipeline.bids.map((r) => r.vendorName)).toEqual(["Pacific Plumbing"]);
    expect(pipeline.sent.map((r) => r.vendorName).sort()).toEqual(["Cascade Drains", "Harborview", "Waiting Co"]);
    expect(pipeline.sent.find((r) => r.vendorName === "Cascade Drains")!.estimateCents).toBe(30_000);
    expect(pipeline.counts).toMatchObject({ bids: 1, sent: 3, scheduled: 0, done: 0 });
  });

  it("an estimate is never a bid: it cannot be approved", () => {
    const bids = [bid({ amountCents: null, materialsCents: 0, bidSubmittedAt: null, estimateCents: 30_000 })];
    const pipeline = buildServicePipeline({ job: job(), offers: [offer()], bids, roster, jobTrade: "Plumbing" });
    expect(pipeline.bids).toEqual([]);
    expect(pipeline.sent).toHaveLength(1);
  });
});

describe("Scheduled and Done", () => {
  const accepted = bid({ status: "accepted" });
  it("an approved bid moves the vendor to Scheduled, and the other bids and offers leave Sent and Bids", () => {
    const pipeline = buildServicePipeline({
      job: job({ vendorId: "d1", vendorName: "Pacific Plumbing", scheduledAtIso: "2026-10-08T16:00:00.000Z", bucket: "scheduled" }),
      offers: [offer(), offer({ id: "o2", vendorDirectoryId: "d2", vendorUserId: "u2", vendorName: "Cascade Drains" })],
      bids: [accepted, bid({ id: "b2", vendorUserId: "u2", vendorDirectoryId: "d2", vendorName: "Cascade Drains", status: "declined" })],
      roster,
      jobTrade: "Plumbing",
    });
    expect(pipeline.scheduled).toHaveLength(1);
    expect(pipeline.scheduled[0]).toMatchObject({ vendorName: "Pacific Plumbing", amountCents: 50_000, visitAt: "2026-10-08T16:00:00.000Z" });
    expect(pipeline.sent).toEqual([]);
    expect(pipeline.bids).toEqual([]);
    expect(defaultPipelineTab(pipeline.counts)).toBe("scheduled");
  });

  it("a finished job is Done, with To pay until it is paid, and Pay offered once", () => {
    const base = { vendorId: "d1", vendorName: "Pacific Plumbing", bucket: "completed" as const, automationStatus: "vendor_marked_done" as const };
    const toPay = buildServicePipeline({ job: job(base), offers: [offer()], bids: [accepted], roster, jobTrade: "Plumbing" });
    expect(toPay.done).toHaveLength(1);
    expect(toPay.scheduled).toEqual([]);
    expect(toPay.done[0]).toMatchObject({ paymentFact: "To pay", canPay: true });
    expect(defaultPipelineTab(toPay.counts)).toBe("done");

    const paid = buildServicePipeline({ job: job({ ...base, automationStatus: "paid" }), offers: [offer()], bids: [accepted], roster, jobTrade: "Plumbing" });
    expect(paid.done[0]).toMatchObject({ paymentFact: "Paid", canPay: false });
  });

  it("a vendor assigned straight to the job (no bid cycle) still shows under Scheduled", () => {
    const pipeline = buildServicePipeline({ job: job({ vendorId: "d3", vendorName: "Bright Sparks", assignee: { type: "vendor", id: "d3", name: "Bright Sparks" } }), offers: [], bids: [], roster, jobTrade: "Electrical" });
    expect(pipeline.scheduled.map((r) => r.vendorName)).toEqual(["Bright Sparks"]);
  });

  it("a cancelled job leaves nothing pending", () => {
    const pipeline = buildServicePipeline({ job: job({ status: "Cancelled", bucket: "completed" }), offers: [offer()], bids: [bid()], roster, jobTrade: "Plumbing" });
    expect(pipeline.sent).toEqual([]);
    expect(pipeline.bids).toEqual([]);
    expect(pipeline.scheduled).toEqual([]);
    expect(pipeline.done).toEqual([]);
  });

  it("states the visit and the money as plain facts", () => {
    const fact = pipelineJobFact(
      { key: "k", vendorName: "Pacific", vendorDirectoryId: "d1", request: null, visitAt: "2026-10-08T16:00:00.000Z", amountCents: 50_000, paymentFact: null, canPay: false },
      () => "Wed, Oct 8 · 9am",
    );
    expect(fact).toBe("Wed, Oct 8 · 9am · $500");
    expect(pipelineJobFact({ key: "k", vendorName: "P", vendorDirectoryId: null, request: null, visitAt: null, amountCents: null, paymentFact: null, canPay: false }, () => "")).toBe("No visit time yet");
  });
});

describe("the default tab follows where the job is", () => {
  const counts = (over: Partial<Record<(typeof PIPELINE_TABS)[number], number>>) => ({ available: 0, sent: 0, bids: 0, scheduled: 0, done: 0, ...over });
  it("Done, Scheduled, Bids, Sent, else Available", () => {
    expect(defaultPipelineTab(counts({ done: 1, scheduled: 1 }))).toBe("done");
    expect(defaultPipelineTab(counts({ scheduled: 1, bids: 2 }))).toBe("scheduled");
    expect(defaultPipelineTab(counts({ bids: 2, sent: 1 }))).toBe("bids");
    expect(defaultPipelineTab(counts({ sent: 1, available: 3 }))).toBe("sent");
    expect(defaultPipelineTab(counts({ available: 3 }))).toBe("available");
    expect(defaultPipelineTab(counts({}))).toBe("available");
  });
});

describe("the Send job bar", () => {
  it("says Send job to N, is off until something is picked, and caps at ten", () => {
    expect(sendBarState(0, false)).toMatchObject({ label: "Send job", disabled: true, capped: false });
    expect(sendBarState(3, false)).toMatchObject({ label: "Send job to 3", disabled: false, count: 3 });
    expect(sendBarState(0, true)).toMatchObject({ label: "Send job to PropLane vendors", disabled: false });
    const many = sendBarState(14, false);
    expect(many).toMatchObject({ count: MAX_VENDORS_PER_JOB_SEND, label: "Send job to 10", capped: true });
  });
});
