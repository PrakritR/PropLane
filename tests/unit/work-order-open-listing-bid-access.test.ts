/**
 * C152: `resolveVendorWorkOrderAccess` (src/lib/work-order-bids.server.ts) must
 * admit ANY vendor once a work order has an open `work_order_open_listings`
 * row — but ONLY for submit/withdraw, and that vendor must get no directory
 * footprint until they actually win (integrator review, 2026-09-25):
 *
 *  1. An `open_listing` access kind may submit/withdraw its own bid, but is
 *     explicitly refused from `scheduleWorkOrderConsultation` (assigned/offered
 *     only) — it must never escalate into the assigned-vendor flow.
 *  2. `submitWorkOrderBid` never creates a `manager_vendor_records` row — every
 *     losing bidder must leave the manager's directory untouched.
 *  3. `acceptWorkOrderBid` creates that directory row lazily, ONLY for the
 *     bidder actually being accepted, and stamps it back onto the bid.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalInboxMessage: vi.fn(async () => undefined) }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/work-order-offer-expiry.server", () => ({ fillSiblingOffers: vi.fn(async () => undefined) }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: vi.fn(async () => []),
}));
vi.mock("@/lib/sms/sms-test-provenance.server", () => ({ stampSmsTestProvenance: (row: unknown) => row }));

import {
  scheduleWorkOrderConsultation,
  submitWorkOrderBid,
  withdrawWorkOrderBid,
  acceptWorkOrderBid,
} from "@/lib/work-order-bids.server";

let OPEN_LISTING_EXISTS: boolean;
let OFFER_EXISTS: boolean;
let INSERTS: Record<string, unknown>[];
let DELETES: number;
let DIRECTORY_ROW: { id: string } | null;
let DIRECTORY_UPDATES: Record<string, unknown>[];
let DIRECTORY_INSERTS: Record<string, unknown>[];

/** A permissive fallback builder for tables this test doesn't specifically assert on
 * (work_order_vendor_offers writes, work_order_open_listings' best-effort close, …) —
 * every chain method returns itself and any terminal read resolves to an empty result. */
function genericStub() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "not", "order", "limit", "range", "ilike", "update", "upsert", "insert", "delete"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  builder.single = vi.fn(async () => ({ data: null, error: null }));
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return builder;
}

function makeDb() {
  return {
    from(table: string) {
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          update: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: { manager_user_id: "mgr-1", vendor_user_id: "assigned-elsewhere-vendor", row_data: { id: "wo-1", biddingOpen: true } },
            error: null,
          })),
        };
        return builder;
      }
      if (table === "work_order_vendor_offers") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          update: vi.fn(() => builder),
          limit: vi.fn(async () => ({ data: OFFER_EXISTS ? [{ id: "offer-1" }] : [], error: null })),
          maybeSingle: vi.fn(async () => ({ data: OFFER_EXISTS ? { id: "offer-1" } : null, error: null })),
        };
        return builder;
      }
      if (table === "work_order_open_listings") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          update: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: OPEN_LISTING_EXISTS ? { id: "listing-1" } : null, error: null })),
        };
        return builder;
      }
      if (table === "work_order_bids") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          neq: vi.fn(() => builder),
          in: vi.fn(() => builder),
          not: vi.fn(() => Promise.resolve({ data: [], error: null })),
          insert: vi.fn((row: Record<string, unknown>) => {
            INSERTS.push(row);
            return Promise.resolve({ error: null });
          }),
          upsert: vi.fn(() => Promise.resolve({ error: null })),
        };
        builder.maybeSingle = vi.fn(async () => {
          if (builder._deleting) {
            DELETES += 1;
            return { data: DELETES > 0 ? { id: "bid-1" } : null, error: null };
          }
          return { data: null, error: null };
        });
        builder.delete = vi.fn(() => {
          builder._deleting = true;
          return builder;
        });
        builder.update = vi.fn((row: Record<string, unknown>) => {
          builder._pendingUpdate = row;
          return builder;
        });
        return builder;
      }
      if (table === "manager_vendor_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          // vendorNamesById awaits `.select(...).in("id", ids)` directly (no `.maybeSingle()`).
          in: vi.fn(() => Promise.resolve({ data: [], error: null })),
          maybeSingle: vi.fn(async () => ({ data: DIRECTORY_ROW, error: null })),
          insert: vi.fn(async (row: Record<string, unknown>) => {
            DIRECTORY_INSERTS.push(row);
            return { error: null };
          }),
          update: vi.fn((row: Record<string, unknown>) => {
            DIRECTORY_UPDATES.push(row);
            return Promise.resolve({ error: null });
          }),
        };
        return builder;
      }
      if (table === "profiles") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: { full_name: "New Vendor", email: "new-vendor@test.proplane.local", phone: null }, error: null })),
        };
        return builder;
      }
      if (table === "vendor_business_profiles") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        return builder;
      }
      return genericStub();
    },
  };
}

const NEW_VENDOR = { userId: "new-vendor", email: "new-vendor@test.proplane.local", fullName: "New Vendor", admin: false, role: "vendor" };
const OFFERED_VENDOR = { userId: "some-other-vendor", email: "offered@test.proplane.local", fullName: "Offered Vendor", admin: false, role: "vendor" };
const MANAGER = { userId: "mgr-1", email: "mgr@test.proplane.local", fullName: "Manager", admin: false, role: "manager" };

const BID_BODY = {
  workOrderId: "wo-1",
  amountCents: 20_000,
  materialsCents: 0,
  proposedTime: "2026-10-01T10:00:00.000Z",
  note: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  INSERTS = [];
  DELETES = 0;
  DIRECTORY_ROW = null;
  DIRECTORY_UPDATES = [];
  DIRECTORY_INSERTS = [];
  OFFER_EXISTS = false;
});

describe("submitWorkOrderBid — open marketplace door", () => {
  it("refuses a vendor nobody offered the job to when no listing is open", async () => {
    OPEN_LISTING_EXISTS = false;
    const result = await submitWorkOrderBid(makeDb() as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(INSERTS).toHaveLength(0);
  });

  it("admits any vendor once the work order has an open marketplace listing", async () => {
    OPEN_LISTING_EXISTS = true;
    const result = await submitWorkOrderBid(makeDb() as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(INSERTS).toHaveLength(1);
  });

  it("stamps the open listing id onto the bid record", async () => {
    OPEN_LISTING_EXISTS = true;
    const result = await submitWorkOrderBid(makeDb() as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(INSERTS[0]?.open_listing_id).toBe("listing-1");
  });

  it("never creates a manager_vendor_records directory row for a marketplace bidder — every losing bid must leave no trace", async () => {
    OPEN_LISTING_EXISTS = true;
    DIRECTORY_ROW = null;
    const result = await submitWorkOrderBid(makeDb() as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(DIRECTORY_INSERTS).toHaveLength(0);
    expect(INSERTS[0]?.vendor_directory_id).toBeNull();
  });

  it("still resolves an existing directory id for an already-rostered vendor (offered path)", async () => {
    OPEN_LISTING_EXISTS = false;
    OFFER_EXISTS = true;
    DIRECTORY_ROW = { id: "existing-dir-row" };
    const result = await submitWorkOrderBid(makeDb() as never, OFFERED_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(INSERTS[0]?.vendor_directory_id).toBe("existing-dir-row");
    expect(DIRECTORY_INSERTS).toHaveLength(0);
  });
});

describe("withdrawWorkOrderBid — open marketplace door", () => {
  it("refuses withdrawal once the listing is no longer open (and the vendor was never offered)", async () => {
    OPEN_LISTING_EXISTS = false;
    const result = await withdrawWorkOrderBid(makeDb() as never, NEW_VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("allows withdrawal from an open marketplace listing", async () => {
    OPEN_LISTING_EXISTS = true;
    const result = await withdrawWorkOrderBid(makeDb() as never, NEW_VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok).toBe(true);
  });
});

describe("scheduleWorkOrderConsultation — open_listing access kind is explicitly refused", () => {
  it("refuses a marketplace bidder (open_listing access) outright, even though a listing is open", async () => {
    OPEN_LISTING_EXISTS = true;
    OFFER_EXISTS = false;
    const result = await scheduleWorkOrderConsultation(makeDb() as never, NEW_VENDOR as never, { workOrderId: "wo-1", mode: "manual", consultationVisitAt: "2026-10-05T10:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("still allows an offered vendor to schedule a consultation — access kind gating is additive, not a regression", async () => {
    OPEN_LISTING_EXISTS = false;
    OFFER_EXISTS = true;
    const result = await scheduleWorkOrderConsultation(makeDb() as never, OFFERED_VENDOR as never, {
      workOrderId: "wo-1",
      mode: "manual",
      consultationVisitAt: "2026-10-05T10:00:00.000Z",
    });
    expect(result.ok).toBe(true);
  });
});

describe("acceptWorkOrderBid — lazy directory creation for the WINNER only", () => {
  let BID_DIRECTORY_UPDATES: Record<string, unknown>[];

  /** Every `db.from("work_order_bids")` call gets its own fresh builder (as the real
   * client does), so state never bleeds between the several distinct chains
   * `acceptWorkOrderBid` runs in sequence: fetch the bid, flip it to accepted
   * (`.update().select("id")`, awaited as an array), the new directory-id backfill
   * (`.update()` with no select, result discarded), and the "other submitted bids"
   * fetch (`.select("*")...`, awaited as an array). */
  function makeAcceptDb(bidFixture: Record<string, unknown>) {
    // The source code mutates `record.vendor_directory_id` directly on the object
    // `.maybeSingle()` hands back. Clone here so a shared `ACCEPTED_BID` const never
    // leaks a mutation from one test into the next.
    const bid = { ...bidFixture };
    const db = makeDb();
    const original = db.from.bind(db);
    (db as { from: unknown }).from = (table: string) => {
      if (table !== "work_order_bids") return original(table);
      const builder: Record<string, unknown> = {};
      let pendingUpdate: Record<string, unknown> | undefined;
      let selectCols: string | undefined;
      for (const m of ["eq", "neq", "in", "not", "order", "limit"]) builder[m] = vi.fn(() => builder);
      builder.select = vi.fn((cols: string) => {
        selectCols = cols;
        return builder;
      });
      builder.update = vi.fn((row: Record<string, unknown>) => {
        pendingUpdate = row;
        if ("vendor_directory_id" in row) BID_DIRECTORY_UPDATES.push(row);
        return builder;
      });
      builder.maybeSingle = vi.fn(async () => ({ data: pendingUpdate ? { ...bid, ...pendingUpdate } : bid, error: null }));
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        let result: { data: unknown; error: null };
        if (pendingUpdate && selectCols === "id") {
          result = { data: [{ id: bid.id }], error: null }; // accept-status update -> .select("id")
        } else if (pendingUpdate) {
          result = { data: null, error: null }; // directory-id backfill, no select, discarded
        } else {
          result = { data: [], error: null }; // "other submitted bids" fetch — none in this test
        }
        return Promise.resolve(result).then(resolve);
      };
      return builder;
    };
    return db;
  }

  const ACCEPTED_BID = {
    id: "bid-1",
    work_order_id: "wo-1",
    vendor_user_id: "new-vendor",
    vendor_directory_id: null,
    manager_user_id: "mgr-1",
    open_listing_id: "listing-1",
    quote_mode: "upfront",
    consultation_visit_at: null,
    amount_cents: 20_000,
    materials_cents: 0,
    proposed_time: "2026-10-01T10:00:00.000Z",
    note: null,
    status: "submitted",
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
  };

  beforeEach(() => {
    BID_DIRECTORY_UPDATES = [];
  });

  it("creates a manager_vendor_records row for a marketplace winner with no existing directory row", async () => {
    DIRECTORY_ROW = null;
    const db = makeAcceptDb(ACCEPTED_BID);
    const result = await acceptWorkOrderBid(db as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok).toBe(true);
    expect(DIRECTORY_INSERTS).toHaveLength(1);
    expect(DIRECTORY_INSERTS[0]?.vendor_user_id).toBe("new-vendor");
    expect(DIRECTORY_INSERTS[0]?.manager_user_id).toBe("mgr-1");
  });

  it("stamps the newly created directory id back onto the bid row", async () => {
    DIRECTORY_ROW = null;
    const db = makeAcceptDb(ACCEPTED_BID);
    const result = await acceptWorkOrderBid(db as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok).toBe(true);
    expect(BID_DIRECTORY_UPDATES).toHaveLength(1);
    expect(BID_DIRECTORY_UPDATES[0]?.vendor_directory_id).toBeTruthy();
  });

  it("does NOT create a directory row when the accepted bidder already has one", async () => {
    DIRECTORY_ROW = { id: "existing-dir-row" };
    const db = makeAcceptDb({ ...ACCEPTED_BID, vendor_directory_id: "existing-dir-row" });
    const result = await acceptWorkOrderBid(db as never, MANAGER as never, { bidId: "bid-1" });
    expect(result.ok).toBe(true);
    expect(DIRECTORY_INSERTS).toHaveLength(0);
    expect(BID_DIRECTORY_UPDATES).toHaveLength(0);
  });
});

describe("setVendorPriceForWorkOrder / markWorkOrderDoneByVendor — never reachable through the open marketplace", () => {
  /** Neither function calls resolveVendorWorkOrderAccess at all — both check
   * `portal_work_order_records.vendor_user_id === actor.userId` directly, which an
   * open-listing bidder (not yet accepted) never satisfies. These are regression
   * tests locking that in, per the integrator's "per operation" audit request. */
  function makeUnassignedWorkOrderDb() {
    return {
      from(table: string) {
        if (table === "portal_work_order_records") {
          const builder: Record<string, unknown> = {
            select: vi.fn(() => builder),
            eq: vi.fn(() => builder),
            update: vi.fn(() => builder),
            maybeSingle: vi.fn(async () => ({
              data: {
                manager_user_id: "mgr-1",
                // The bidder is NOT the assigned vendor — an open-listing bid never sets this.
                vendor_user_id: "assigned-elsewhere-vendor",
                row_data: { id: "wo-1", bucket: "scheduled" },
              },
              error: null,
            })),
          };
          return builder;
        }
        return genericStub();
      },
    };
  }

  it("setVendorPriceForWorkOrder refuses an open-listing bidder who has not been assigned", async () => {
    const { setVendorPriceForWorkOrder } = await import("@/lib/work-order-bids.server");
    const db = makeUnassignedWorkOrderDb();
    const result = await setVendorPriceForWorkOrder(db as never, NEW_VENDOR as never, {
      workOrderId: "wo-1",
      amountCents: 10_000,
      materialsCents: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("markWorkOrderDoneByVendor refuses an open-listing bidder who has not been assigned", async () => {
    const { markWorkOrderDoneByVendor } = await import("@/lib/work-order-bids.server");
    const db = makeUnassignedWorkOrderDb();
    const result = await markWorkOrderDoneByVendor(db as never, NEW_VENDOR as never, { workOrderId: "wo-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});
