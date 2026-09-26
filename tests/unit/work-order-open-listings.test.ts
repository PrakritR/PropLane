/**
 * C152 Open marketplace listing: the projection is an explicit allowlist (like
 * `publicListingProjection`), ownership is re-derived server-side (never a
 * client-supplied id), and only a vendor may browse open listings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));

import {
  browseOpenListings,
  closeWorkOrderBidding,
  getOwnOpenListing,
  openWorkOrderForBidding,
  publicOpenListingProjection,
  type OpenListingRecord,
} from "@/lib/work-order-open-listings.server";

const RAW_ROW: OpenListingRecord = {
  id: "listing-1",
  work_order_id: "wo-1",
  manager_user_id: "mgr-1",
  trade: "Plumbing",
  area: "Brooklyn, NY",
  description: "Leaky kitchen faucet, needs a new cartridge.",
  timeframe: "This week",
  budget_min_cents: 10_000,
  budget_max_cents: 25_000,
  status: "open",
  opened_at: "2026-09-25T00:00:00.000Z",
  closed_at: null,
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:00:00.000Z",
};

describe("publicOpenListingProjection", () => {
  it("carries only the marketplace-safe fields", () => {
    const projected = publicOpenListingProjection(RAW_ROW);
    expect(Object.keys(projected).sort()).toEqual(
      ["area", "budgetMaxCents", "budgetMinCents", "description", "id", "openedAt", "timeframe", "trade"].sort(),
    );
  });

  it("never leaks manager_user_id, work_order_id, or internal status/timestamps", () => {
    const projected = publicOpenListingProjection(RAW_ROW) as Record<string, unknown>;
    expect(projected.managerUserId).toBeUndefined();
    expect(projected.manager_user_id).toBeUndefined();
    expect(projected.workOrderId).toBeUndefined();
    expect(projected.work_order_id).toBeUndefined();
    expect(projected.status).toBeUndefined();
    expect(projected.closedAt).toBeUndefined();
    expect(projected.createdAt).toBeUndefined();
    expect(projected.updatedAt).toBeUndefined();
  });
});

type Row = Record<string, unknown>;

function makeDb(opts: { workOrder: Row | null; listingRow?: Row | null; listingRows?: Row[] }) {
  const state = { listingRow: opts.listingRow ?? null, listingRows: opts.listingRows ?? [] };
  return {
    from(table: string) {
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: opts.workOrder, error: null })),
        };
        return builder;
      }
      if (table === "work_order_open_listings") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          order: vi.fn(() => builder),
          range: vi.fn(() => Promise.resolve({ data: state.listingRows, error: null })),
          ilike: vi.fn(() => builder),
          maybeSingle: vi.fn(async () => ({ data: state.listingRow, error: null })),
          upsert: vi.fn(() => builder),
          update: vi.fn(() => builder),
          single: vi.fn(async () => ({
            data: { ...RAW_ROW, ...state.listingRow },
            error: null,
          })),
        };
        return builder;
      }
      return {};
    },
    __state: state,
  };
}

const MANAGER = { userId: "mgr-1", email: "mgr@test.proplane.local", fullName: "Manager", admin: false, role: "manager" };
const OTHER_MANAGER = { userId: "mgr-2", email: "other@test.proplane.local", fullName: "Other", admin: false, role: "manager" };
const VENDOR = { userId: "vendor-1", email: "vendor@test.proplane.local", fullName: "Vendor", admin: false, role: "vendor" };

describe("openWorkOrderForBidding — ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  const BODY = {
    workOrderId: "wo-1",
    trade: "Plumbing",
    area: "Brooklyn, NY",
    description: "Leaky faucet.",
  };

  it("refuses a manager who does not own the work order", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await openWorkOrderForBidding(db as never, OTHER_MANAGER as never, BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses a vendor actor outright", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await openWorkOrderForBidding(db as never, VENDOR as never, BODY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects an empty description or area", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await openWorkOrderForBidding(db as never, MANAGER as never, { ...BODY, description: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("rejects a minimum budget above the maximum", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await openWorkOrderForBidding(db as never, MANAGER as never, {
      ...BODY,
      budgetMinCents: 50_000,
      budgetMaxCents: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("publishes for the owning manager", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await openWorkOrderForBidding(db as never, MANAGER as never, BODY);
    expect(result.ok).toBe(true);
  });
});

describe("closeWorkOrderBidding / getOwnOpenListing — ownership", () => {
  it("refuses to close another manager's listing", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await closeWorkOrderBidding(db as never, OTHER_MANAGER as never, { workOrderId: "wo-1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses to read another manager's own-listing view", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await getOwnOpenListing(db as never, OTHER_MANAGER as never, "wo-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("refuses a vendor reading the manager-only own-listing view", async () => {
    const db = makeDb({ workOrder: { manager_user_id: "mgr-1" } });
    const result = await getOwnOpenListing(db as never, VENDOR as never, "wo-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe("browseOpenListings — vendor-only", () => {
  it("refuses a manager actor", async () => {
    const db = makeDb({ workOrder: null, listingRows: [] });
    const result = await browseOpenListings(db as never, MANAGER as never, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("returns only the projected fields for a vendor", async () => {
    const db = makeDb({ workOrder: null, listingRows: [RAW_ROW as unknown as Row] });
    const result = await browseOpenListings(db as never, VENDOR as never, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listings).toHaveLength(1);
    expect(Object.keys(result.listings[0]!).sort()).toEqual(
      ["area", "budgetMaxCents", "budgetMinCents", "description", "id", "openedAt", "timeframe", "trade"].sort(),
    );
    expect((result.listings[0] as Record<string, unknown>).workOrderId).toBeUndefined();
  });

  it("ignores a trade value outside the known vendor trade list", async () => {
    const db = makeDb({ workOrder: null, listingRows: [RAW_ROW as unknown as Row] });
    const result = await browseOpenListings(db as never, VENDOR as never, { trade: "'; drop table work_order_open_listings; --" });
    expect(result.ok).toBe(true);
  });
});
