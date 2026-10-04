import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";

const store = vi.hoisted(() => ({
  rows: [] as DemoManagerWorkOrderRow[],
  upsert: vi.fn(),
  write: vi.fn(),
  updateRequest: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  readManagerWorkOrderRows: () => store.rows,
  syncManagerWorkOrdersFromServer: async () => store.rows,
  upsertManagerWorkOrderToServer: store.upsert,
  writeManagerWorkOrderRows: store.write,
}));
vi.mock("@/lib/service-requests-storage", () => ({ updateServiceRequest: store.updateRequest }));
vi.mock("@/lib/work-order-vendor-offers", () => ({ sendWorkOrderToVendors: store.send }));

import { ensureAddOnVendorJob, sendAddOnToVendors } from "@/lib/add-on-vendor-job-actions";

const addOn: ServiceRequest = {
  id: "SR-1", offerId: "storage", offerName: "Storage locker", offerDescription: "Basement locker", price: "$40", deposit: "",
  residentEmail: "liam@example.com", residentName: "Liam Foster", managerUserId: "mgr-1", propertyId: "prop-a", returnByDate: "",
  notes: "", requestedAt: "2026-10-02T00:00:00.000Z", status: "approved", servicePaid: false, depositPaid: false,
};
const ctx = { propertyName: "Alder House", managerUserId: "mgr-1" };

beforeEach(() => {
  store.rows = [];
  store.upsert.mockReset().mockImplementation(async (row: DemoManagerWorkOrderRow) => ({ ok: true, row }));
  store.write.mockReset();
  store.updateRequest.mockReset();
  store.send.mockReset().mockResolvedValue({ ok: true, sent: ["d1", "d2"] });
});

describe("the first Send job on an add-on", () => {
  it("creates ONE linked work order with no resident, links it both ways, then sends it through the offer path", async () => {
    const result = await sendAddOnToVendors(addOn, ctx, ["d1", "d2"]);
    expect(result).toEqual({ ok: true, workOrderId: "SR-1-vendor-job", sent: 2 });
    const saved = store.upsert.mock.calls[0]![0] as DemoManagerWorkOrderRow;
    expect(saved).toMatchObject({ id: "SR-1-vendor-job", linkedServiceRequestId: "SR-1", title: "Storage locker", propertyName: "Alder House" });
    // The resident's charge stays on the add-on: the job carries no resident to bill.
    expect(saved.residentEmail).toBeUndefined();
    expect(saved.residentChargeCents).toBeUndefined();
    expect(store.updateRequest).toHaveBeenCalledWith("SR-1", { linkedWorkOrderId: "SR-1-vendor-job" });
    expect(store.write.mock.calls[0]![1]).toEqual({ mirror: false });
    expect(store.send).toHaveBeenCalledWith("SR-1-vendor-job", ["d1", "d2"], undefined);
  });

  it("a second send reuses the job and never creates another", async () => {
    store.rows = [{ id: "SR-1-vendor-job", linkedServiceRequestId: "SR-1" } as DemoManagerWorkOrderRow];
    const result = await ensureAddOnVendorJob({ ...addOn, linkedWorkOrderId: "SR-1-vendor-job" }, ctx);
    expect(result).toEqual({ ok: true, workOrderId: "SR-1-vendor-job", created: false });
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("does not offer anything when the job could not be saved", async () => {
    store.upsert.mockResolvedValue({ ok: false, error: "Forbidden." });
    const result = await sendAddOnToVendors(addOn, ctx, ["d1"]);
    expect(result).toEqual({ ok: false, error: "Forbidden." });
    expect(store.send).not.toHaveBeenCalled();
    expect(store.updateRequest).not.toHaveBeenCalled();
  });

  it("passes the marketplace opt-in through untouched", async () => {
    await sendAddOnToVendors(addOn, ctx, ["d1"], { enabled: true, trade: "General", radiusMi: 10 });
    expect(store.send).toHaveBeenCalledWith("SR-1-vendor-job", ["d1"], { enabled: true, trade: "General", radiusMi: 10 });
  });
});
