import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import {
  addOnVendorJobId,
  applyVendorJobToAddOn,
  buildAddOnVendorJobRow,
  isLinkedVendorJob,
  linkedVendorJobFor,
  withoutLinkedVendorJobs,
  workOrderMayBillResident,
} from "@/lib/add-on-vendor-job";
import { projectWorkOrderForOfferedVendor } from "@/lib/work-order-vendor-privacy";
import { assignableKindsFor } from "@/lib/work-assignment";

/**
 * An add-on service on a vendor (studio plan mobile-step-tabs-1004, D7): the vendor workflow rides a LINKED
 * work order. The resident's charge stays on the add-on only; the vendor job carries just the vendor's bill.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const addOn = (over: Partial<ServiceRequest> = {}): ServiceRequest => ({
  id: "SR-1", offerId: "storage", offerName: "Storage locker", offerDescription: "Basement locker, 4x6", price: "$40", deposit: "$50",
  residentEmail: "liam@example.com", residentName: "Liam Foster", managerUserId: "mgr-1", propertyId: "prop-a", returnByDate: "",
  notes: "", requestedAt: "2026-10-02T00:00:00.000Z", status: "approved", servicePaid: false, depositPaid: false, ...over,
});

describe("the vendor job behind an add-on", () => {
  const row = buildAddOnVendorJobRow(addOn(), { propertyName: "Alder House", managerUserId: "mgr-1" });

  it("carries the job, the property and the area - linked both ways by a deterministic id", () => {
    expect(row.id).toBe(addOnVendorJobId("SR-1"));
    expect(row.id).toBe("SR-1-vendor-job");
    expect(row.linkedServiceRequestId).toBe("SR-1");
    expect(row).toMatchObject({ title: "Storage locker", description: "Basement locker, 4x6", propertyName: "Alder House", propertyId: "prop-a", managerUserId: "mgr-1", bucket: "open" });
  });

  it("has no resident and no resident charge, so no charge generator has anything to bill", () => {
    expect(row.residentEmail).toBeUndefined();
    expect(row.residentName).toBeUndefined();
    expect(row.residentChargeCents).toBeUndefined();
    expect(row.residentChargeId).toBeUndefined();
    expect(workOrderMayBillResident(row)).toBe(false);
    // An ordinary maintenance service still bills its resident.
    expect(workOrderMayBillResident({})).toBe(true);
    expect(workOrderMayBillResident(null)).toBe(true);
  });

  it("every client charge generator in the services panel checks the guard before billing a resident", () => {
    const src = read("src/components/portal/pro-work-orders-panel.tsx");
    const calls = [...src.matchAll(/recordWorkOrderResidentCharge\(\{/g)].map((m) => m.index!);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const at of calls) {
      const before = src.slice(Math.max(0, at - 900), at);
      expect(before).toContain("workOrderMayBillResident(");
    }
  });

  it("the server never announces the job as a new service, and an offered vendor is never told which add-on it serves", () => {
    expect(read("src/app/api/portal-work-orders/route.ts")).toMatch(/if \(isLinkedVendorJob\(row\)\) return;/);
    const projected = projectWorkOrderForOfferedVendor({ ...row, propertyAddress: "12 Alder St", offerSharePhotos: false });
    expect(projected).not.toHaveProperty("linkedServiceRequestId");
    expect(projected).not.toHaveProperty("propertyAddress");
    expect(projected.propertyName).not.toContain("12 Alder St");
  });
});

describe("telling the two models apart", () => {
  const plain: DemoManagerWorkOrderRow = { ...buildAddOnVendorJobRow(addOn(), { propertyName: "A", managerUserId: "m" }), id: "wo-plain", linkedServiceRequestId: undefined };
  const linked = buildAddOnVendorJobRow(addOn(), { propertyName: "A", managerUserId: "m" });

  it("the Services lists never draw a linked job as a service of its own", () => {
    expect(isLinkedVendorJob(linked)).toBe(true);
    expect(isLinkedVendorJob(plain)).toBe(false);
    expect(withoutLinkedVendorJobs([plain, linked]).map((r) => r.id)).toEqual(["wo-plain"]);
  });

  it("finds the job by the add-on's link or by its own back-reference", () => {
    expect(linkedVendorJobFor(addOn({ linkedWorkOrderId: "SR-1-vendor-job" }), [plain, linked])?.id).toBe("SR-1-vendor-job");
    expect(linkedVendorJobFor(addOn(), [plain, linked])?.id).toBe("SR-1-vendor-job");
    expect(linkedVendorJobFor(addOn({ id: "SR-9" }), [plain, linked])).toBeNull();
  });

  it("a vendor may now be assigned an add-on service (via its job), but never a tour", () => {
    expect(assignableKindsFor("vendor")).toContain("service");
    expect(assignableKindsFor("vendor")).not.toContain("tour");
  });
});

describe("the add-on reads the job once a vendor is on it", () => {
  const job = (over: Partial<DemoManagerWorkOrderRow> = {}): DemoManagerWorkOrderRow => ({
    ...buildAddOnVendorJobRow(addOn(), { propertyName: "A", managerUserId: "m" }), ...over,
  });

  it("the hired vendor becomes the assignee and the visit time the visit", () => {
    const next = applyVendorJobToAddOn(addOn(), job({ vendorId: "d1", vendorName: "Pacific Plumbing", scheduledAtIso: "2026-10-08T16:00:00.000Z", bucket: "scheduled" }));
    expect(next.assignee).toEqual({ type: "vendor", id: "d1", name: "Pacific Plumbing" });
    expect(next.proposedVisit?.iso).toBe("2026-10-08T16:00:00.000Z");
    expect(next.status).toBe("approved");
  });

  it("a finished job completes an approved add-on, but never a pending or declined one", () => {
    const done = job({ vendorId: "d1", vendorName: "P", bucket: "completed", automationStatus: "vendor_marked_done" });
    expect(applyVendorJobToAddOn(addOn(), done).status).toBe("returned");
    expect(applyVendorJobToAddOn(addOn({ status: "pending" }), done).status).toBe("pending");
    expect(applyVendorJobToAddOn(addOn({ status: "denied" }), done).status).toBe("denied");
  });

  it("never replaces a teammate who already has it, and leaves the request alone with no job", () => {
    const mine = addOn({ assignee: { type: "team", id: "mgr-1", name: "You" } });
    expect(applyVendorJobToAddOn(mine, job({ vendorId: "d1", vendorName: "P" })).assignee).toEqual({ type: "team", id: "mgr-1", name: "You" });
    const req = addOn();
    expect(applyVendorJobToAddOn(req, null)).toBe(req);
    expect(applyVendorJobToAddOn(req, { ...job(), linkedServiceRequestId: undefined })).toBe(req);
  });
});
