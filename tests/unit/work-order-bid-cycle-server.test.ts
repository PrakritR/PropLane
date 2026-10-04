/**
 * Estimate vs bid on the server (docs/agents/services-system.md): approving refuses anything that is
 * not a submitted bid and anything outside the caller's workspace; an estimate never becomes a
 * payment; the estimate-visit fee is billed once, only after the visit happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { track, ensureVisitFeeInvoice, rateLimit } = vi.hoisted(() => ({
  track: vi.fn(),
  ensureVisitFeeInvoice: vi.fn(async () => ({ created: true })),
  rateLimit: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/work-order-visit-fee-invoice.server", () => ({ ensureVisitFeeInvoice }));

import {
  acceptWorkOrderBid,
  completeEstimateVisit,
  giveWorkOrderEstimate,
  scheduleWorkOrderConsultation,
  submitWorkOrderBid,
} from "@/lib/work-order-bids.server";

type Row = Record<string, unknown> | null;
type Store = {
  bid: Row;
  workOrder: Row;
  offer: Row;
  /** Ids the `status = "accepted"` lookup finds on the work order; empty means none. */
  acceptedBidIds: string[];
};
let STORE: Store;
let WRITES: Array<{ table: string; op: string; values?: Record<string, unknown>; filters: Array<[string, unknown]> }>;

function makeDb() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let pending: { op: string; values?: Record<string, unknown> } | null = null;
      const rowFor = (): Row => {
        if (table === "work_order_bids") return STORE.bid;
        if (table === "portal_work_order_records") return STORE.workOrder;
        if (table === "work_order_vendor_offers") return STORE.offer;
        if (table === "manager_vendor_records") return { id: "dir-1" };
        return null;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
        neq: () => builder,
        in: () => builder,
        is: (c: string, v: unknown) => (filters.push([c, v]), builder),
        not: () => builder,
        limit: () => builder,
        order: () => builder,
        update: (values: Record<string, unknown>) => ((pending = { op: "update", values }), builder),
        insert: (values: Record<string, unknown>) => {
          WRITES.push({ table, op: "insert", values, filters });
          return Promise.resolve({ error: null });
        },
        delete: () => ((pending = { op: "delete" }), builder),
        maybeSingle: async () => {
          if (pending) {
            WRITES.push({ table, op: pending.op, values: pending.values, filters: [...filters] });
            return { data: { id: "x" }, error: null };
          }
          return { data: rowFor(), error: null };
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pending) WRITES.push({ table, op: pending.op, values: pending.values, filters: [...filters] });
          const acceptedLookup =
            table === "work_order_bids" && filters.some(([c, v]) => c === "status" && v === "accepted");
          const rows = pending
            ? [{ id: "x" }]
            : acceptedLookup
              ? STORE.acceptedBidIds.map((id) => ({ id }))
              : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const MANAGER = { userId: "mgr-1", email: "m@test.proplane.local", fullName: "Mgr", admin: false, role: "manager" };
const VENDOR = { userId: "vendor-1", email: "v@test.proplane.local", fullName: "Vendor", admin: false, role: "vendor" };

const bidRow = (over: Record<string, unknown> = {}) => ({
  id: "bid-1",
  work_order_id: "wo-1",
  vendor_user_id: "vendor-1",
  vendor_directory_id: "dir-1",
  manager_user_id: "mgr-1",
  quote_mode: "upfront",
  consultation_visit_at: null,
  amount_cents: null,
  materials_cents: 0,
  proposed_time: null,
  note: null,
  status: "submitted",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  estimate_cents: null,
  estimate_given_at: null,
  bid_submitted_at: null,
  estimate_visit_fee_cents: 0,
  estimate_visit_done_at: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  WRITES = [];
  STORE = {
    bid: bidRow(),
    workOrder: { manager_user_id: "mgr-1", vendor_user_id: null, row_data: { id: "wo-1", title: "Leaky faucet", biddingOpen: true } },
    offer: { id: "offer-1" },
    acceptedBidIds: [],
  };
});

describe("approving a bid", () => {
  it("refuses a row with no submitted bid (an estimate alone) with a 422 and writes nothing", async () => {
    STORE.bid = bidRow({ estimate_cents: 18_000, estimate_given_at: "2026-10-02T00:00:00.000Z" });
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
    expect(WRITES).toHaveLength(0);
  });

  it("refuses a booked visit with no bid yet", async () => {
    STORE.bid = bidRow({ quote_mode: "after_consultation", consultation_visit_at: "2026-10-05T17:00:00.000Z" });
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok === false && result.status).toBe(422);
  });

  it("refuses a priced row that was never stamped as a submitted bid", async () => {
    STORE.bid = bidRow({ amount_cents: 20_000 });
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok === false && result.status).toBe(422);
  });

  it("refuses another workspace's manager (403) before touching anything", async () => {
    STORE.bid = bidRow({ amount_cents: 20_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    const result = await acceptWorkOrderBid(makeDb() as never, { ...MANAGER, userId: "mgr-other" } as never, { bidId: "bid-1" });
    expect(result.ok === false && result.status).toBe(403);
    expect(WRITES).toHaveLength(0);
  });

  it("refuses when the service's real owner differs from the bid's denormalized manager", async () => {
    STORE.bid = bidRow({ amount_cents: 20_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    STORE.workOrder = { manager_user_id: "mgr-other", vendor_user_id: null, row_data: {} };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok === false && result.status).toBe(403);
  });

  it("refuses a bid that does not belong to the service the caller named", async () => {
    STORE.bid = bidRow({ amount_cents: 20_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-other" });
    expect(result.ok === false && result.status).toBe(403);
    expect(WRITES).toHaveLength(0);
  });

  it("approves a submitted bid using the STORED amount, books its time, and never reads a body amount", async () => {
    STORE.bid = bidRow({ amount_cents: 20_000, materials_cents: 2_500, proposed_time: "2026-10-08T16:00:00.000Z", bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1", amountCents: 1 } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amountCents).toBe(20_000);
    const accepted = WRITES.find((w) => w.table === "work_order_bids" && w.values?.status === "accepted");
    expect(accepted).toBeTruthy();
    expect(accepted!.values).not.toHaveProperty("amount_cents");
    const woPatch = WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update");
    const rowData = woPatch!.values!.row_data as Record<string, unknown>;
    expect(rowData).toMatchObject({ scheduledAtIso: "2026-10-08T16:00:00.000Z", bucket: "scheduled", vendorCostCents: 20_000 });
  });
});

/**
 * Re-approving the SAME bid is the only way back from a half-applied approval, so it must finish
 * what is missing and touch nothing that already landed.
 */
describe("re-approving an already-accepted bid", () => {
  const acceptedBid = () =>
    bidRow({
      status: "accepted",
      amount_cents: 20_000,
      materials_cents: 2_500,
      proposed_time: "2026-10-08T16:00:00.000Z",
      bid_submitted_at: "2026-10-02T00:00:00.000Z",
    });

  it("leaves a work order already hired by that vendor alone and only re-runs the cleanup", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: {
        id: "wo-1",
        title: "Leaky faucet",
        vendorId: "dir-1",
        vendorAssignedAt: "2026-10-03T00:00:00.000Z",
        // The visit was moved after the approval; a retry must not roll it back.
        bucket: "scheduled",
        scheduledAtIso: "2026-10-12T21:00:00.000Z",
        biddingOpen: false,
      },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    expect(WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update")).toBeUndefined();
    expect(WRITES.find((w) => w.table === "work_order_bids" && w.values?.status === "accepted")).toBeUndefined();
    const withdraw = WRITES.find((w) => w.table === "work_order_vendor_offers" && w.values?.status === "withdrawn");
    expect(withdraw).toBeTruthy();
  });

  it("applies the hire when the accept landed but the assign write did not", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: null,
      row_data: { id: "wo-1", title: "Leaky faucet", biddingOpen: true },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    const woPatch = WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update");
    expect(woPatch).toBeTruthy();
    expect(woPatch!.values!.vendor_user_id).toBe("vendor-1");
    expect(woPatch!.values!.row_data).toMatchObject({ vendorCostCents: 20_000, bucket: "scheduled" });
    // The bid is already accepted, so the status write is not repeated.
    expect(WRITES.find((w) => w.table === "work_order_bids" && w.values?.status === "accepted")).toBeUndefined();
  });

  it("still refuses a DIFFERENT bid once one is accepted", async () => {
    STORE.bid = bidRow({ amount_cents: 30_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    STORE.acceptedBidIds = ["bid-winner"];
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok === false && result.status).toBe(409);
    expect(WRITES).toHaveLength(0);
  });

  it("does not mistake its own accepted row for a rival on a retry", async () => {
    STORE.bid = acceptedBid();
    STORE.acceptedBidIds = ["bid-1"];
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-1",
      row_data: { id: "wo-1", vendorAssignedAt: "2026-10-03T00:00:00.000Z" },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
  });

  /**
   * Reassigning a service does not touch `work_order_bids`, so the old vendor's bid stays
   * accepted while the row loses `vendorAssignedAt`. A retry must read that as "someone else is
   * on it", never as "the hire never landed".
   */
  it("does not revert a service handed to a teammate", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: null,
      row_data: {
        id: "wo-1",
        title: "Leaky faucet",
        vendorId: undefined,
        vendorName: undefined,
        vendorAssignedAt: undefined,
        selfAssigned: true,
        assignee: { type: "team", id: "teammate-1", name: "Dana" },
      },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    expect(WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update")).toBeUndefined();
  });

  it("does not revert a service the manager took on themselves", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: null,
      row_data: {
        id: "wo-1",
        title: "Leaky faucet",
        vendorAssignedAt: undefined,
        selfAssigned: true,
        assignee: { type: "team", id: "mgr-1", name: "You" },
      },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    expect(WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update")).toBeUndefined();
  });

  it("does not revert a service already handed to a different vendor", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: "vendor-other",
      row_data: { id: "wo-1", vendorId: "dir-other", vendorAssignedAt: "2026-10-04T00:00:00.000Z" },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    expect(WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update")).toBeUndefined();
  });

  it("re-hires a service the manager unassigned, since nobody holds it", async () => {
    STORE.bid = acceptedBid();
    STORE.workOrder = {
      manager_user_id: "mgr-1",
      vendor_user_id: null,
      row_data: {
        id: "wo-1",
        title: "Leaky faucet",
        vendorId: undefined,
        vendorName: undefined,
        vendorAssignedAt: undefined,
        selfAssigned: false,
        assignee: undefined,
      },
    };
    const result = await acceptWorkOrderBid(makeDb() as never, MANAGER as never, { bidId: "bid-1", workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    const woPatch = WRITES.find((w) => w.table === "portal_work_order_records" && w.op === "update");
    expect(woPatch!.values!.vendor_user_id).toBe("vendor-1");
  });
});

describe("an estimate never becomes a payment", () => {
  it("giving an estimate stores estimate_cents only - no bid price, no bid stamp", async () => {
    STORE.bid = null;
    const result = await giveWorkOrderEstimate(makeDb() as never, VENDOR as never, { workOrderId: "wo-1", estimateCents: 18_000 });
    // Vendor access needs an offer or assignment; the mock supplies an offer.
    expect(result.ok).toBe(true);
    const insert = WRITES.find((w) => w.table === "work_order_bids" && w.op === "insert");
    expect(insert!.values).toMatchObject({ estimate_cents: 18_000, amount_cents: null, status: "submitted" });
    expect(insert!.values).not.toHaveProperty("bid_submitted_at");
  });

  it("refuses a non-vendor and a non-positive estimate", async () => {
    expect((await giveWorkOrderEstimate(makeDb() as never, MANAGER as never, { workOrderId: "wo-1", estimateCents: 100 })).ok).toBe(false);
    const zero = await giveWorkOrderEstimate(makeDb() as never, VENDOR as never, { workOrderId: "wo-1", estimateCents: 0 });
    expect(zero.ok === false && zero.status).toBe(400);
  });

  it("refuses an estimate after the bid was submitted", async () => {
    STORE.bid = bidRow({ amount_cents: 15_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    const result = await giveWorkOrderEstimate(makeDb() as never, VENDOR as never, { workOrderId: "wo-1", estimateCents: 12_000 });
    expect(result.ok === false && result.status).toBe(409);
  });
});

describe("submitting a bid", () => {
  it("stamps bid_submitted_at (after an estimate the row is updated, estimate kept)", async () => {
    STORE.bid = bidRow({ estimate_cents: 18_000 });
    const result = await submitWorkOrderBid(makeDb() as never, VENDOR as never, {
      workOrderId: "wo-1",
      amountCents: 20_000,
      materialsCents: 0,
      proposedTime: "2026-10-08T16:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    const update = WRITES.find((w) => w.table === "work_order_bids" && w.op === "update");
    expect(update!.values).toMatchObject({ amount_cents: 20_000 });
    expect(typeof update!.values!.bid_submitted_at).toBe("string");
    expect(update!.values).not.toHaveProperty("estimate_cents");
  });

  it("will not re-price an accepted bid (the amount stays the payout anchor)", async () => {
    STORE.bid = bidRow({ status: "accepted", amount_cents: 20_000, bid_submitted_at: "2026-10-02T00:00:00.000Z" });
    const result = await submitWorkOrderBid(makeDb() as never, VENDOR as never, {
      workOrderId: "wo-1",
      amountCents: 1,
      proposedTime: "2026-10-08T16:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    expect(WRITES.filter((w) => w.table === "work_order_bids")).toHaveLength(0);
  });
});

describe("the estimate visit fee", () => {
  it("is not billed while the visit has not happened", async () => {
    STORE.bid = bidRow({
      quote_mode: "after_consultation",
      consultation_visit_at: new Date(Date.now() + 86_400_000).toISOString(),
      estimate_visit_fee_cents: 4_000,
    });
    const result = await completeEstimateVisit(makeDb() as never, VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok === false && result.status).toBe(422);
    expect(ensureVisitFeeInvoice).not.toHaveBeenCalled();
  });

  it("needs a booked visit first", async () => {
    const result = await completeEstimateVisit(makeDb() as never, VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok === false && result.status).toBe(422);
    expect(ensureVisitFeeInvoice).not.toHaveBeenCalled();
  });

  it("files exactly the stored fee once the visit happened", async () => {
    STORE.bid = bidRow({
      quote_mode: "after_consultation",
      consultation_visit_at: "2026-09-30T17:00:00.000Z",
      estimate_visit_fee_cents: 4_000,
    });
    const result = await completeEstimateVisit(makeDb() as never, VENDOR as never, { workOrderId: "wo-1", feeCents: 99_999 } as never);
    expect(result).toMatchObject({ ok: true, feeCents: 4_000 });
    expect(ensureVisitFeeInvoice).toHaveBeenCalledTimes(1);
    expect(ensureVisitFeeInvoice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bidId: "bid-1", feeCents: 4_000, managerUserId: "mgr-1" }));
  });

  it("files no invoice for a free visit", async () => {
    STORE.bid = bidRow({ quote_mode: "after_consultation", consultation_visit_at: "2026-09-30T17:00:00.000Z" });
    const result = await completeEstimateVisit(makeDb() as never, VENDOR as never, { workOrderId: "wo-1" });
    expect(result).toMatchObject({ ok: true, feeCents: 0 });
    expect(ensureVisitFeeInvoice).not.toHaveBeenCalled();
  });

  it("a retry after the visit was already marked done re-checks for the invoice but does not re-stamp", async () => {
    STORE.bid = bidRow({
      quote_mode: "after_consultation",
      consultation_visit_at: "2026-09-30T17:00:00.000Z",
      estimate_visit_done_at: "2026-09-30T18:00:00.000Z",
      estimate_visit_fee_cents: 4_000,
    });
    const result = await completeEstimateVisit(makeDb() as never, VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
    expect(WRITES.filter((w) => w.table === "work_order_bids" && w.values && "estimate_visit_done_at" in w.values)).toHaveLength(0);
    expect(ensureVisitFeeInvoice).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-range fee when booking the visit, and locks the fee once the visit is done", async () => {
    const tooHigh = await scheduleWorkOrderConsultation(makeDb() as never, VENDOR as never, {
      workOrderId: "wo-1",
      mode: "manual",
      consultationVisitAt: "2026-10-05T17:00:00.000Z",
      visitFeeCents: 10_000_000,
    });
    expect(tooHigh.ok === false && tooHigh.status).toBe(400);
    STORE.bid = bidRow({ estimate_visit_done_at: "2026-09-30T18:00:00.000Z", consultation_visit_at: "2026-09-30T17:00:00.000Z" });
    const locked = await scheduleWorkOrderConsultation(makeDb() as never, VENDOR as never, {
      workOrderId: "wo-1",
      mode: "manual",
      consultationVisitAt: "2026-10-05T17:00:00.000Z",
      visitFeeCents: 9_000,
    });
    expect(locked.ok === false && locked.status).toBe(409);
  });
});
