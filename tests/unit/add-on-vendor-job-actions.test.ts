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

import { ensureAddOnVendorJob, payVendorJob, sendAddOnToVendors } from "@/lib/add-on-vendor-job-actions";

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

/**
 * `/api/portal/work-orders/approve-pay` answers a card/ACH payment with an EMBEDDED
 * Checkout client secret, never a hosted redirect URL. The payment is not taken until
 * that form is mounted and completed, so `payVendorJob` must hand the secret back for
 * mounting — a bare `{ ok: true }` would let the host toast "Approved and paid." over a
 * vendor who was never paid and a stranded `pendingVendorPay` claim.
 */
describe("Pay vendor on an add-on's linked job", () => {
  const job = { id: "SR-1-vendor-job", title: "Storage locker", cost: "$400.00",
    vendorCostCents: 40_000, category: "general" } as unknown as DemoManagerWorkOrderRow;

  it("hands back the embedded Checkout secret instead of reporting a settled payment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: true, clientSecret: "cs_secret_123", sessionId: "cs_123" }),
      { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await payVendorJob(job);

    expect(result).toEqual({ ok: true, clientSecret: "cs_secret_123", sessionId: "cs_123" });
    expect(result).not.toHaveProperty("checkoutUrl");
  });

  it("reports a settled payment only when the server returns no checkout to mount", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } })));

    expect(await payVendorJob(job)).toEqual({ ok: true });
  });

  it("surfaces the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Payment already started" }),
      { status: 409, headers: { "Content-Type": "application/json" } })));

    expect(await payVendorJob(job)).toEqual({ ok: false, error: "Payment already started" });
  });
});
