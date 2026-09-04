/**
 * PRP-231. The accepted bid's `amount_cents` is documented as the immutable
 * payout anchor. It was not: `submitWorkOrderBid` read `existing.status`, then
 * wrote with no status predicate, so a manager accepting the bid in between
 * had the accepted amount overwritten and the row flipped back to "submitted".
 * The payout's `status = "accepted"` lookup then missed and paid the
 * caller-supplied amount instead — the one number the anchor exists to distrust.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("@/lib/analytics/posthog", () => ({ track }));

import { submitWorkOrderBid } from "@/lib/work-order-bids.server";
import { payoutVendorForWorkOrder } from "@/lib/stripe-vendor-payout";

/** The bid row as stored, and the status the conditional write will match on. */
let STORED_BID: { id: string; status: string; quote_mode: string; consultation_visit_at: string | null } | null;
/** Status the row actually has when the UPDATE lands — the accept may have won the race. */
let STATUS_AT_WRITE: string;
let UPDATES: Array<Record<string, unknown>>;
let INSERTS: Array<Record<string, unknown>>;

function makeBidDb() {
  return {
    from(table: string) {
      if (table === "work_order_bids") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn((column: string, value: unknown) => {
            if (column === "status") builder._requiredStatus = value;
            return builder;
          }),
          maybeSingle: vi.fn(async () => {
            if (builder._pendingUpdate) {
              const matched = builder._requiredStatus === undefined || builder._requiredStatus === STATUS_AT_WRITE;
              if (!matched) return { data: null, error: null };
              UPDATES.push(builder._pendingUpdate as Record<string, unknown>);
              return { data: { id: STORED_BID?.id ?? "bid-1" }, error: null };
            }
            return { data: STORED_BID, error: null };
          }),
          update: vi.fn((row: Record<string, unknown>) => {
            builder._pendingUpdate = row;
            return builder;
          }),
          insert: vi.fn((row: Record<string, unknown>) => {
            INSERTS.push(row);
            return Promise.resolve({ error: null });
          }),
        };
        return builder;
      }
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: async () => ({
            data: {
              manager_user_id: "mgr-1",
              vendor_user_id: "vendor-1",
              row_data: { id: "wo-1", biddingOpen: true },
            },
            error: null,
          }),
        };
        return builder;
      }
      if (table === "manager_vendor_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: async () => ({ data: { id: "vendor-dir-1" }, error: null }),
        };
        return builder;
      }
      return {};
    },
  };
}

const BODY = {
  workOrderId: "wo-1",
  amountCents: 50_000,
  materialsCents: 0,
  proposedTime: "2026-10-01T10:00:00.000Z",
  note: "",
};
const ACTOR = { userId: "vendor-1", email: "vendor@test.proplane.local", role: "vendor" };

describe("submitWorkOrderBid — accept-between-read-and-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    UPDATES = [];
    INSERTS = [];
    STORED_BID = { id: "bid-1", status: "submitted", quote_mode: "upfront", consultation_visit_at: null };
    STATUS_AT_WRITE = "submitted";
  });

  it("re-prices a bid that is still submitted at write time", async () => {
    const result = await submitWorkOrderBid(makeBidDb() as never, ACTOR as never, BODY);
    expect(result.ok).toBe(true);
    expect(UPDATES).toHaveLength(1);
    expect(UPDATES[0]?.amount_cents).toBe(50_000);
  });

  it("refuses when the manager accepted the bid after the status read", async () => {
    STATUS_AT_WRITE = "accepted";
    const result = await submitWorkOrderBid(makeBidDb() as never, ACTOR as never, BODY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(UPDATES).toHaveLength(0);
  });

  it("inserts a first bid rather than upserting over an unseen row", async () => {
    STORED_BID = null;
    const result = await submitWorkOrderBid(makeBidDb() as never, ACTOR as never, BODY);
    expect(result.ok).toBe(true);
    expect(INSERTS).toHaveLength(1);
    expect(UPDATES).toHaveLength(0);
  });
});

/** Payout half of the same chain. */
let PAYOUT_BIDS: Array<{ amount_cents: number | null; status: string | null }>;
let PAYOUT_INSERTS: Array<Record<string, unknown>>;

function makePayoutDb() {
  return {
    from(table: string) {
      if (table === "work_order_bids") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: PAYOUT_BIDS, error: null }).then(resolve),
        };
        return builder;
      }
      if (table === "vendor_payouts") {
        const builder: Record<string, unknown> = {
          insert: vi.fn((row: Record<string, unknown>) => {
            PAYOUT_INSERTS.push(row);
            return builder;
          }),
          update: vi.fn(() => builder),
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }
      return {};
    },
  };
}

describe("payoutVendorForWorkOrder — the anchor", () => {
  beforeEach(() => {
    PAYOUT_INSERTS = [];
  });

  const OPTS = { workOrderId: "wo-1", managerUserId: "mgr-1", vendorUserId: "vendor-1", amountCents: 999_00 };

  it("pays the accepted bid's amount, not the caller's", async () => {
    PAYOUT_BIDS = [{ amount_cents: 50_000, status: "accepted" }];
    await payoutVendorForWorkOrder(makePayoutDb() as never, OPTS);
    expect(PAYOUT_INSERTS[0]?.amount_cents).toBe(50_000);
  });

  it("pays nothing when the job was bid but no bid is accepted", async () => {
    PAYOUT_BIDS = [{ amount_cents: 50_000, status: "submitted" }];
    await payoutVendorForWorkOrder(makePayoutDb() as never, OPTS);
    expect(PAYOUT_INSERTS).toHaveLength(0);
  });

  it("still pays the caller's amount for a job assigned without any bidding", async () => {
    PAYOUT_BIDS = [];
    await payoutVendorForWorkOrder(makePayoutDb() as never, OPTS);
    expect(PAYOUT_INSERTS[0]?.amount_cents).toBe(999_00);
  });
});
