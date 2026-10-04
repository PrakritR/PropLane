import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  managerServiceListStageLabel,
  managerServiceNextStep,
  resolveWorkOrderAssignee,
} from "@/lib/manager-service-workflow";
import { workOrderStageSteps } from "@/lib/service-lifecycle";
import {
  managerServiceListGlyphFact,
  managerServiceStageFactRedundantWithAssignee,
} from "@/lib/manager-service-list-row";
import { Scale, Users } from "lucide-react";
import { vendorCanSeeFullWorkOrderSite, workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";

function baseRow(overrides: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow {
  return {
    id: "wo-1",
    propertyName: "5257 Brooklyn Ave NE, Seattle",
    propertyId: "p1",
    managerUserId: "m1",
    unit: "—",
    title: "Leak",
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: "Drip",
    scheduled: "—",
    cost: "$120",
    ...overrides,
  };
}

describe("managerServiceWorkflow", () => {
  it("hides redundant Hired stage when assignee fact is shown", () => {
    expect(
      managerServiceStageFactRedundantWithAssignee(
        { kind: "vendor", id: "v1", name: "Dana Plumbing" },
        "Assigned",
      ),
    ).toBe(true);
    expect(managerServiceStageFactRedundantWithAssignee(null, "3 bids")).toBe(false);
  });

  it("picks one list glyph fact — stage beats assignee when both apply", () => {
    const assignee = { kind: "vendor" as const, id: "v1", name: "Dana Plumbing" };
    expect(
      managerServiceListGlyphFact(assignee, { icon: Scale, text: "3 bids" }),
    ).toEqual({ icon: Scale, text: "3 bids" });
    expect(
      managerServiceListGlyphFact(assignee, { icon: Users, text: "Assigned" }),
    ).toEqual({ icon: Users, text: "Dana Plumbing" });
    expect(managerServiceListGlyphFact(null, { icon: Scale, text: "Unassigned" })).toEqual({
      icon: Scale,
      text: "Unassigned",
    });
  });

  it("labels list stage from bids and publish state", () => {
    const row = baseRow({ biddingOpen: true });
    expect(managerServiceListStageLabel(row, 0)).toBe("Requested");
    expect(managerServiceListStageLabel(row, 3)).toBe("3 bids");
  });

  it("omits Paid step for team assignee", () => {
    const row = baseRow({
      assignee: { type: "team", id: "t1", name: "Luis Ortega" },
    });
    const steps = workOrderStageSteps(row, { bids: [], offers: [] });
    expect(steps.map((s) => s.id)).toEqual(["open", "assigned", "scheduled", "completed"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "current", "todo", "todo"]);
    expect(resolveWorkOrderAssignee(row)?.kind).toBe("team");
  });

  it("adds Paid to the stepper for a vendor job only", () => {
    const vendor = baseRow({ vendorId: "v1", vendorName: "Dana Plumbing", bucket: "completed", automationStatus: "paid" });
    const steps = workOrderStageSteps(vendor, { bids: [], offers: [] });
    expect(steps.map((s) => s.label)).toEqual(["Open", "Assigned", "Scheduled", "Completed", "Paid"]);
    expect(steps.at(-1)?.state).toBe("current");
  });

  it("the one next step follows the lifecycle: Request bids, Compare bids, Schedule, Complete, Pay", () => {
    expect(managerServiceNextStep(baseRow())?.label).toBe("Request bids");
    expect(managerServiceNextStep(baseRow({ biddingOpen: true }))).toBeNull();
    expect(managerServiceNextStep(baseRow({ biddingOpen: true }), { bidCount: 2 })?.label).toBe("Compare bids");
    const hired = { vendorId: "v1", vendorName: "Dana Plumbing" };
    expect(managerServiceNextStep(baseRow(hired))?.label).toBe("Schedule");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }))?.label).toBe("Complete");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "completed", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), { canPay: true })?.label).toBe("Pay");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "completed", status: "Cancelled" }), { canPay: true })).toBeNull();
  });

  it("vendor lead hides street until hired", () => {
    const row = baseRow({
      propertyAddress: "5257 Brooklyn Ave NE, Seattle, WA",
      biddingOpen: true,
    });
    expect(workOrderGeneralArea(row)).toBe("Seattle");
    expect(vendorCanSeeFullWorkOrderSite(row, null)).toBe(false);
    expect(
      vendorCanSeeFullWorkOrderSite(row, {
        id: "b1",
        workOrderId: row.id,
        vendorUserId: "v1",
        vendorDirectoryId: "vd1",
        status: "accepted",
        amountCents: 10000,
        materialsCents: 0,
        proposedTime: null,
        note: null,
        quoteMode: "upfront",
        consultationVisitAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});
