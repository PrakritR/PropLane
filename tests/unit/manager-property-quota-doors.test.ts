/**
 * Per-door billing, step 2: `assertManagerPropertyListingQuota` caps Free by
 * DOORS (`RATE_CARD.free.includedDoors`), never by listing count, and never
 * refuses Pro or Business for listing count at all — they price extra doors
 * instead (`RATE_CARD`). See `manager-property-cap-override.test.ts` for the
 * staff-pinned override, which stays a listing-count cap on any tier.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_CARD } from "@/lib/billing/rate-card";

let EFFECTIVE_TIER: string | null = "free";
let SLOT_ROWS: { id: string; manager_user_id: string; status: string }[] = [];

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: EFFECTIVE_TIER }),
}));

const { assertManagerPropertyListingQuota } = await import("@/lib/manager-property-quota.server");

const OWNER = "mgr-doors";
const FREE_DOOR_CAP = RATE_CARD.free.includedDoors;

/** No staff override, and every slot row reads as one "unrecorded" door — `doorCountForListing`'s
 * own floor for a listing with no rooms/place-category recorded, same convention the override
 * test's mock uses. */
function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select() {
          return q;
        },
        eq(col: string, value: unknown) {
          filters[col] = value;
          return q;
        },
        in(col: string, values: unknown[]) {
          filters[`in:${col}`] = values;
          return q;
        },
        neq(col: string, value: unknown) {
          filters[`neq:${col}`] = value;
          return q;
        },
        async maybeSingle() {
          return { data: { row_data: {} }, error: null };
        },
        then(resolve: (v: { count: number; data: unknown[]; error: null }) => unknown) {
          const statuses = (filters["in:status"] ?? []) as string[];
          const rows = SLOT_ROWS.filter(
            (r) =>
              r.manager_user_id === filters.manager_user_id &&
              statuses.includes(r.status) &&
              r.id !== filters["neq:id"],
          );
          void table;
          return Promise.resolve({ count: rows.length, data: rows, error: null }).then(resolve);
        },
      };
      return q;
    },
  } as never;
}

function liveRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, manager_user_id: OWNER, status: "live" }));
}

beforeEach(() => {
  EFFECTIVE_TIER = "free";
  SLOT_ROWS = [];
});

describe("Free — hard door cap, no overage rate", () => {
  it("refuses a listing that would push a 2-door account to a third door, naming doors", async () => {
    SLOT_ROWS = liveRows(FREE_DOOR_CAP); // already at the cap: 2 unrecorded listings = 2 doors
    const verdict = await assertManagerPropertyListingQuota(makeDb(), {
      ownerUserId: OWNER,
      recordId: "new-listing",
      nextStatus: "live",
      existingStatus: null,
      incomingDoors: 1,
    });
    expect(verdict).toMatchObject({ ok: false, status: 403, tier: "free", limit: FREE_DOOR_CAP, current: FREE_DOOR_CAP });
    expect((verdict as { error: string }).error.toLowerCase()).toContain("door");
  });

  it("allows a listing that stays at or under the 2-door cap", async () => {
    SLOT_ROWS = liveRows(FREE_DOOR_CAP - 1); // 1 existing door, 1 incoming = 2, at the cap
    const verdict = await assertManagerPropertyListingQuota(makeDb(), {
      ownerUserId: OWNER,
      recordId: "new-listing",
      nextStatus: "live",
      existingStatus: null,
      incomingDoors: 1,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses a single room-partitioned listing whose own doors alone exceed the cap", async () => {
    const verdict = await assertManagerPropertyListingQuota(makeDb(), {
      ownerUserId: OWNER,
      recordId: "new-listing",
      nextStatus: "live",
      existingStatus: null,
      incomingDoors: FREE_DOOR_CAP + 1,
    });
    expect(verdict).toMatchObject({ ok: false, status: 403, limit: FREE_DOOR_CAP });
  });
});

describe("Pro and Business — priced by doors, never refused for listing count", () => {
  it("never refuses a Pro account, however many listings or doors it already holds", async () => {
    EFFECTIVE_TIER = "pro";
    SLOT_ROWS = liveRows(50);
    const verdict = await assertManagerPropertyListingQuota(makeDb(), {
      ownerUserId: OWNER,
      recordId: "new-listing",
      nextStatus: "live",
      existingStatus: null,
      incomingDoors: 25,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("never refuses a Business account, however many listings or doors it already holds", async () => {
    EFFECTIVE_TIER = "business";
    SLOT_ROWS = liveRows(200);
    const verdict = await assertManagerPropertyListingQuota(makeDb(), {
      ownerUserId: OWNER,
      recordId: "new-listing",
      nextStatus: "live",
      existingStatus: null,
      incomingDoors: 200,
    });
    expect(verdict).toEqual({ ok: true });
  });
});
