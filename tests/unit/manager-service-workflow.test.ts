import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  managerServiceListStageLabel,
  managerServiceNextStep,
  managerServiceNeed,
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
    expect(managerServiceNextStep(baseRow({ biddingOpen: true }), { bidCount: 1 })?.label).toBe("Approve bid");
    expect(managerServiceNextStep(baseRow({ biddingOpen: true }), { bidCount: 2 })?.label).toBe("Compare bids");
    const hired = { vendorId: "v1", vendorName: "Dana Plumbing" };
    expect(managerServiceNextStep(baseRow(hired))?.label).toBe("Schedule");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }))?.label).toBe("Complete");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "completed", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), { canPay: true })?.label).toBe("Pay");
    expect(managerServiceNextStep(baseRow({ ...hired, bucket: "completed", status: "Cancelled" }), { canPay: true })).toBeNull();
  });

  it("the Needs you row follows the same next step as the header primary", () => {
    const hired = { vendorId: "v1", vendorName: "Dana Plumbing" };
    const need = (row: ReturnType<typeof baseRow>, opts = {}) => managerServiceNeed(row, opts);
    expect(need(baseRow())).toEqual({ id: "request-bids", title: "Request bids", key: "request-bids" });
    expect(need(baseRow({ biddingOpen: true }))).toEqual({ id: "waiting-on-vendors", title: "Waiting on vendors", key: null });
    expect(need(baseRow({ biddingOpen: true }), { bidCount: 1 })?.title).toBe("Approve a bid");
    expect(need(baseRow({ biddingOpen: true }), { bidCount: 3 })?.title).toBe("Approve a bid");
    expect(need(baseRow(hired))?.title).toBe("Schedule");
    expect(need(baseRow({ ...hired, bucket: "scheduled", scheduledAtIso: "2026-10-08T16:00:00.000Z" }))?.title).toBe("Complete");
    expect(
      need(baseRow({ ...hired, bucket: "completed", scheduledAtIso: "2026-10-08T16:00:00.000Z", automationStatus: "vendor_marked_done" }))?.title,
    ).toBe("Approve invoice");
    expect(need(baseRow({ ...hired, bucket: "completed", scheduledAtIso: "2026-10-08T16:00:00.000Z" }), { canPay: true })?.title).toBe("Pay");
    expect(need(baseRow({ status: "Cancelled" }))).toBeNull();
    // "Assign a vendor" is never the need: a bid in means Approve a bid.
    expect(need(baseRow({ biddingOpen: true }), { bidCount: 1 })?.title).not.toBe("Assign a vendor");
  });

  it("vendor lead hides street until hired", () => {
    const row = baseRow({
      propertyAddress: "5257 Brooklyn Ave NE, Seattle, WA",
      biddingOpen: true,
    });
    // The city — and the state when the address names one — is what a vendor browsing leads needs
    // to bid at all. The ZIP is dropped (it narrows the area to a few blocks), the street never
    // appears, and `propertyName` is never a fallback (a distinctive house name identifies the
    // property as surely as its street).
    expect(workOrderGeneralArea(row)).toBe("Seattle, WA");
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, Seattle, WA 98105", propertyName: "Proof House" })).toBe("Seattle, WA");
    // A trailing country is dropped before the city is read, and two parts are enough.
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, Seattle, WA 98101, USA", propertyName: "Proof House" })).toBe("Seattle, WA");
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, Seattle", propertyName: "Proof House" })).toBe("Seattle");
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, Unit A, Seattle", propertyName: "Proof House" })).toBe("Seattle");
    // Real city names keep their punctuation; "Main St" is still rejected as a street.
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, St. Louis, MO 63101", propertyName: "Proof House" })).toBe("St. Louis, MO");
    expect(workOrderGeneralArea({ propertyAddress: "99 Oak Rd, Winston-Salem, NC", propertyName: "Proof House" })).toBe("Winston-Salem, NC");
    // No derivable city is "Nearby": one part, a street line where the city belongs, and a unit
    // designator are all refused rather than guessed at.
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St", propertyName: "Proof House" })).toBe("Nearby");
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, WA", propertyName: "Proof House" })).toBe("Nearby");
    expect(workOrderGeneralArea({ propertyAddress: "123 Main St, Unit A, WA", propertyName: "Proof House" })).toBe("Nearby");
    expect(workOrderGeneralArea({ propertyAddress: "", propertyName: "Proof House" })).toBe("Nearby");
    const forgedHint = { propertyAddress: "123 Main St", propertyName: "Proof House", offeredGeneralArea: "Proof House" };
    expect(workOrderGeneralArea(forgedHint)).toBe("Nearby");
    // A house name sitting where the street belongs leaks nothing: only the city travels.
    expect(workOrderGeneralArea({ propertyAddress: "Proof House, Seattle", propertyName: "Proof House" })).toBe("Seattle");
    // A SECONDARY address line is an address line, never a city: on a two-part address the last
    // part would otherwise be read as the city and shipped as the area.
    for (const secondary of ["Building C", "Bldg C", "Penthouse", "Lot A", "Space B", "Trailer C", "Basement", "Dept B"]) {
      expect(workOrderGeneralArea({ propertyAddress: `123 Main St, ${secondary}`, propertyName: "Proof House" })).toBe("Nearby");
    }
    // Real cities whose names carry one of those words stay cities.
    for (const [address, area] of [
      ["123 Main St, Ste. Genevieve, MO", "Ste. Genevieve, MO"],
      ["123 Main St, Upper Darby, PA", "Upper Darby, PA"],
      ["123 Main St, Front Royal, VA", "Front Royal, VA"],
      ["123 Main St, Key West, FL", "Key West, FL"],
    ] as const) {
      expect(workOrderGeneralArea({ propertyAddress: address, propertyName: "Proof House" })).toBe(area);
    }
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
