import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { applyAcceptedBid, managerServiceNextStep, resolveWorkOrderAssignee } from "@/lib/manager-service-workflow";
import { workOrderServiceStage, workOrderStageFact, workOrderStageSteps } from "@/lib/service-lifecycle";
import { JOB_SEND_RADIUS_OPTIONS, buildServicePipeline, defaultPipelineTab } from "@/lib/service-pipeline";

/**
 * A service approved the older way (or in another tab) has its hire on the ACCEPTED BID before the manager's
 * local mirror of the row says so. The accepted bid is the source of truth: the stage, the stepper, the next
 * step, the Who card and the Vendors pipeline all read the vendor, the booked visit and the price from it.
 */
const row = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
  id: "wo-1", propertyName: "Alder House", unit: "2B", title: "Kitchen faucet drip", priority: "Medium", status: "Open", bucket: "open",
  description: "", scheduled: "", cost: "", ...over,
});
const accepted: WorkOrderBid = {
  id: "b-1", workOrderId: "wo-1", vendorUserId: "u-9", vendorDirectoryId: "v-9", vendorName: "Pacific Plumbing", quoteMode: "upfront",
  consultationVisitAt: null, amountCents: 14_000, materialsCents: 0, proposedTime: "2026-10-08T16:00:00.000Z", note: null, status: "accepted",
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", bidSubmittedAt: "2026-10-02T00:00:00.000Z",
};
const roster = [
  { id: "v-9", name: "Pacific Plumbing", trade: "Plumbing", active: true },
  { id: "v-2", name: "Cascade Drains", trade: "Plumbing", active: true },
];

describe("applyAcceptedBid", () => {
  it("fills in the vendor, the booked visit and the price the way the server's approval writes them", () => {
    const patched = applyAcceptedBid(row(), [accepted]);
    expect(patched).toMatchObject({
      vendorId: "v-9", vendorName: "Pacific Plumbing", scheduledAtIso: accepted.proposedTime, vendorCostCents: 14_000, bucket: "scheduled", biddingOpen: false,
    });
    expect(resolveWorkOrderAssignee(patched)).toEqual({ kind: "vendor", id: "v-9", name: "Pacific Plumbing" });
  });

  it("makes the stage Scheduled, the stepper and the stage fact agree, and the next step Complete", () => {
    const stale = row();
    expect(workOrderServiceStage(stale, { bids: [accepted], offers: [] })).toBe("scheduled");
    expect(workOrderStageSteps(stale, { bids: [accepted], offers: [] }).find((s) => s.state === "current")?.id).toBe("scheduled");
    expect(workOrderStageFact(stale, { bids: [accepted], offers: [] })).toContain("Pacific Plumbing");
    expect(managerServiceNextStep(applyAcceptedBid(stale, [accepted]))).toEqual({ key: "complete", label: "Complete" });
  });

  it("leaves a row held by a teammate, a row that already says it, and a service with no accepted bid alone", () => {
    const team = row({ assignee: { type: "team", id: "t-1", name: "Sam" } });
    expect(applyAcceptedBid(team, [accepted])).toBe(team);
    const said = row({
      bucket: "scheduled", vendorId: "v-9", vendorName: "Pacific Plumbing", vendorCostCents: 14_000, materialsCostCents: 0,
      scheduledAtIso: accepted.proposedTime ?? undefined, biddingOpen: false,
    });
    expect(applyAcceptedBid(said, [accepted])).toBe(said);
    const plain = row();
    expect(applyAcceptedBid(plain, [{ ...accepted, status: "submitted" }])).toBe(plain);
    expect(applyAcceptedBid(plain, [])).toBe(plain);
  });
});

describe("a job approved only on its bid, in the Vendors pipeline", () => {
  it("puts the approved vendor under Scheduled with the visit time and the bid's amount, not under Available or Bids", () => {
    const pipeline = buildServicePipeline({ job: row(), offers: [], bids: [accepted], roster, jobTrade: "Plumbing" });
    expect(pipeline.counts).toMatchObject({ scheduled: 1, bids: 0, sent: 0, done: 0 });
    expect(pipeline.scheduled[0]).toMatchObject({ vendorName: "Pacific Plumbing", visitAt: accepted.proposedTime, amountCents: 14_000 });
    expect(pipeline.available.map((v) => v.id)).toEqual(["v-2"]);
    expect(defaultPipelineTab(pipeline.counts)).toBe("scheduled");
  });
});

describe("the Send job popup's reach", () => {
  it("offers 5, 10 and 25 miles", () => {
    expect([...JOB_SEND_RADIUS_OPTIONS]).toEqual([5, 10, 25]);
  });
});
