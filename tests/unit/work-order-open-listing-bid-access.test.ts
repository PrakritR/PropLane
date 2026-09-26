/**
 * C152: `resolveVendorWorkOrderAccess` (src/lib/work-order-bids.server.ts) must
 * admit ANY vendor once a work order has an open `work_order_open_listings`
 * row — not just a vendor the manager specifically offered the job to — while
 * still refusing everyone else once no listing is open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));

import { submitWorkOrderBid, withdrawWorkOrderBid } from "@/lib/work-order-bids.server";

let OPEN_LISTING_EXISTS: boolean;
let INSERTS: Record<string, unknown>[];
let DELETES: number;
let DIRECTORY_ROW: { id: string } | null;

function makeDb() {
  return {
    from(table: string) {
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({
            data: { manager_user_id: "mgr-1", vendor_user_id: "some-other-vendor", row_data: { id: "wo-1", biddingOpen: false } },
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
          limit: vi.fn(async () => ({ data: [], error: null })),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
        };
        return builder;
      }
      if (table === "work_order_open_listings") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: OPEN_LISTING_EXISTS ? { id: "listing-1" } : null, error: null })),
        };
        return builder;
      }
      if (table === "work_order_bids") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          insert: vi.fn((row: Record<string, unknown>) => {
            INSERTS.push(row);
            return Promise.resolve({ error: null });
          }),
          delete: vi.fn(() => builder),
          then: undefined,
        };
        // `withdrawWorkOrderBid` chains delete().eq().eq().eq().select().maybeSingle()
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
        return builder;
      }
      if (table === "manager_vendor_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: DIRECTORY_ROW, error: null })),
          insert: vi.fn(async () => ({ error: null })),
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
      return {};
    },
  };
}

const NEW_VENDOR = { userId: "new-vendor", email: "new-vendor@test.proplane.local", fullName: "New Vendor", admin: false, role: "vendor" };

const BID_BODY = {
  workOrderId: "wo-1",
  amountCents: 20_000,
  materialsCents: 0,
  proposedTime: "2026-10-01T10:00:00.000Z",
  note: "",
};

describe("resolveVendorWorkOrderAccess via submitWorkOrderBid — open marketplace door", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    INSERTS = [];
    DELETES = 0;
    DIRECTORY_ROW = null;
  });

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

  it("auto-creates a manager_vendor_records directory row for a brand-new marketplace vendor", async () => {
    OPEN_LISTING_EXISTS = true;
    DIRECTORY_ROW = null;
    const db = makeDb();
    const insertSpy = vi.fn(async () => ({ error: null }));
    const original = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = original(table);
      if (table === "manager_vendor_records") (builder as Record<string, unknown>).insert = insertSpy;
      return builder;
    }) as typeof db.from;
    const result = await submitWorkOrderBid(db as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0]![0] as { vendor_user_id: string; manager_user_id: string };
    expect(inserted.vendor_user_id).toBe("new-vendor");
    expect(inserted.manager_user_id).toBe("mgr-1");
  });

  it("reuses an existing directory row instead of creating a duplicate", async () => {
    OPEN_LISTING_EXISTS = true;
    DIRECTORY_ROW = { id: "existing-dir-row" };
    const db = makeDb();
    const insertSpy = vi.fn(async () => ({ error: null }));
    const original = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = original(table);
      if (table === "manager_vendor_records") (builder as Record<string, unknown>).insert = insertSpy;
      return builder;
    }) as typeof db.from;
    const result = await submitWorkOrderBid(db as never, NEW_VENDOR as never, BID_BODY);
    expect(result.ok).toBe(true);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(INSERTS[0]?.vendor_directory_id).toBe("existing-dir-row");
  });
});

describe("resolveVendorWorkOrderAccess via withdrawWorkOrderBid — open marketplace door", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    DELETES = 0;
  });

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
