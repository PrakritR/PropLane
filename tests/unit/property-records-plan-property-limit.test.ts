/**
 * `POST /api/property-records` is a plain upsert with no tier check unless
 * `assertManagerPropertyListingQuota` refuses it — every client posts here
 * directly, so publishing a second, fifth or fiftieth listing needed nothing
 * more than skipping the interface (manager-portal audit, F-SET-1).
 *
 * Per-door billing (PLAN-DOOR step 2) changed WHAT that gate caps:
 *
 * 1. Free has a hard DOOR cap (`RATE_CARD.free.includedDoors`), not a listing
 *    count — a free-plan manager is refused a write that would push their
 *    total doors past the cap, with a message that names doors and what lifts
 *    them (see `manager-property-quota-doors.test.ts` for the arithmetic in
 *    isolation).
 * 2. The refusal does not depend on the interface — it is the same request,
 *    with no client state involved, and the body cannot argue its way past it.
 * 3. A manager already OVER the cap keeps their listings. Editing, unlisting
 *    and deleting an existing row all still work; only an ADDITIONAL slot is
 *    refused. Nothing here ever removes a record.
 * 4. Pro and Business are NEVER refused for listing count — they price extra
 *    doors instead (`RATE_CARD`).
 * 5. Drafts and unlisted rows are not listings and are never charged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";
import { RATE_CARD } from "@/lib/billing/rate-card";

const FREE_DOOR_CAP = RATE_CARD.free.includedDoors;

const getUser = vi.fn();

let EFFECTIVE_TIER: string | null = "free";
let EXISTING_ROW: { manager_user_id: string; status?: string } | null = null;
/** Rows the owner already holds, as the route's reads would see them. Each carries no
 * `row_data`/`property_data`, so every one reads as "unrecorded" — 1 door, `doorCountForListing`'s
 * own floor for a listing with nothing on file. */
let SLOT_ROWS: Array<{ id: string; manager_user_id: string; status: string }> = [];
let COUNT_ERROR: { message: string } | null = null;
/** The plan read itself failing — distinct from the account having no plan. */
let TIER_READ_ERROR: string | null = null;
let UPSERTS: Record<string, unknown>[] = [];
let DELETED_IDS: string[] = [];
/** Every filter the STAFF-OVERRIDE listing-count query applied (`countManagerListingSlots`), so a
 * test can prove it never runs when there is no override — Free's own cap is DOORS, read a
 * different way (`loadManagerDoorCount`, the `manager_property_records` read below with no `count`
 * option). */
let COUNT_FILTERS: Array<Record<string, unknown>> = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));

/**
 * The tier is read from the manager's own `manager_purchases` row by
 * `getEffectiveManagerSkuTier` (service role). Stubbing it here keeps this file
 * about the CAP; the resolution rule itself is covered by
 * `manager-effective-plan-tier.test.ts`.
 */
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () =>
    TIER_READ_ERROR ? { ok: false, error: TIER_READ_ERROR } : { ok: true, tier: EFFECTIVE_TIER },
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      // No staff override in this file (`manager-property-cap-override.test.ts` owns that axis).
      if (table === "manager_automation_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      if (table !== "manager_property_records") throw new Error(`unexpected table: ${table}`);
      return {
        // One flexible builder serves three different callers against this table: the existing-row
        // lookup (`.eq("id", id).maybeSingle()`), the staff-override listing-COUNT read
        // (`.select(cols, {count}).eq(owner).in(status).neq(id)`), and Free's door-cap read
        // (`.select(cols).eq(owner).in(status)`, no `count` option, no `maybeSingle`).
        select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
          const filters: Record<string, unknown> = {};
          const rowsFor = () => {
            let rows = SLOT_ROWS;
            if (typeof filters.owner === "string") rows = rows.filter((r) => r.manager_user_id === filters.owner);
            if (Array.isArray(filters.statuses)) rows = rows.filter((r) => (filters.statuses as string[]).includes(r.status));
            if (typeof filters.excludeId === "string") rows = rows.filter((r) => r.id !== filters.excludeId);
            return rows;
          };
          const builder = {
            eq(col: string, value: string) {
              if (col === "id") filters.id = value;
              if (col === "manager_user_id") filters.owner = value;
              return builder;
            },
            in(_col: string, values: string[]) {
              filters.statuses = values;
              return builder;
            },
            neq(_col: string, value: string) {
              filters.excludeId = value;
              return builder;
            },
            async maybeSingle() {
              return { data: EXISTING_ROW, error: null };
            },
            then(resolve: (v: { count: number | null; data: unknown[] | null; error: unknown }) => unknown) {
              if (opts?.count) COUNT_FILTERS.push(filters);
              if (COUNT_ERROR) return Promise.resolve({ count: null, data: null, error: COUNT_ERROR }).then(resolve);
              const rows = rowsFor();
              return Promise.resolve({ count: rows.length, data: rows, error: null }).then(resolve);
            },
          };
          return builder;
        },
        upsert: async (row: Record<string, unknown>) => {
          UPSERTS.push({ ...row, __table: table });
          return { error: null };
        },
        delete: () => ({
          eq: async (_col: string, value: string) => {
            DELETED_IDS.push(value);
            return { error: null };
          },
        }),
      };
    },
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

const FREE_MANAGER = "mgr-free-1";
const OTHER_MANAGER = "mgr-other-1";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

function liveRows(ownerId: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${ownerId}-listing-${i + 1}`,
    manager_user_id: ownerId,
    status: "live",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  EFFECTIVE_TIER = "free";
  EXISTING_ROW = null;
  SLOT_ROWS = [];
  COUNT_ERROR = null;
  TIER_READ_ERROR = null;
  UPSERTS = [];
  DELETED_IDS = [];
  COUNT_FILTERS = [];
  getUser.mockResolvedValue({ data: { user: { id: FREE_MANAGER } } });
});

describe("Free plan — a listing that would exceed the door cap is refused by the server", () => {
  it("publishes the FIRST listing normally", async () => {
    const res = await post({
      action: "upsert",
      id: "mgr-first",
      status: "live",
      propertyData: { id: "mgr-first" },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("refuses the listing that would push doors past the cap, and says what the limit is and what lifts it", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({
      action: "upsert",
      id: "mgr-over",
      status: "live",
      propertyData: { id: "mgr-over" },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; limit: number; tier: string };
    expect(body.code).toBe("property_limit_reached");
    expect(body.limit).toBe(FREE_DOOR_CAP);
    expect(body.tier).toBe("free");
    // Not an opaque error: the sentence names the plan, the door count, and the way past it.
    expect(body.error).toContain(`Free includes ${FREE_DOOR_CAP} door`);
    expect(body.error).toContain("Upgrade to Pro or Business");
    // And nothing was written.
    expect(UPSERTS).toEqual([]);
  });

  it("holds when the request bypasses the interface entirely", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    // A hand-rolled request: no wizard, no local pipeline state, and a body that
    // tries every value a caller controls — a foreign owner, an unpublished-looking
    // id, a full property payload.
    const res = await post({
      action: "upsert",
      id: "mgr-crafted-by-hand",
      managerUserId: OTHER_MANAGER,
      status: "live",
      rowData: { adminRefId: "mgr-crafted-by-hand" },
      propertyData: { id: "mgr-crafted-by-hand", adminPublishLive: true },
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
  });

  it("cannot be handed someone else's larger allowance through the body", async () => {
    // `managerUserId` is the value this route was already hardened against
    // trusting; the door cap must not have reintroduced it as a way to be
    // counted against a different — emptier — account.
    SLOT_ROWS = [...liveRows(FREE_MANAGER, FREE_DOOR_CAP), ...liveRows(OTHER_MANAGER, 0)];

    const res = await post({
      action: "upsert",
      id: "mgr-x",
      managerUserId: OTHER_MANAGER,
      status: "live",
      propertyData: {},
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
  });

  it("does not charge a draft save, however many drafts already exist", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({
      action: "upsert",
      id: "mgr-draft-9",
      status: "draft",
      rowData: { adminRefId: "mgr-draft-9" },
    });

    expect(res.status).toBe(200);
  });

  it("does not charge unlisting a live listing", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({
      action: "upsert",
      id: "mgr-first",
      status: "unlisted",
      rowData: { adminRefId: "mgr-first" },
    });

    expect(res.status).toBe(200);
  });

  it("refuses publishing a saved DRAFT into an account already at the door cap", async () => {
    // The wizard publishes a resumed draft by re-upserting the SAME id
    // draft → live, so the row exists. That is still a new listing slot.
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "draft" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({
      action: "upsert",
      id: "mgr-saved-draft",
      status: "live",
      propertyData: { id: "mgr-saved-draft" },
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
  });

  it("refuses RELISTING an unlisted row into an account already at the door cap", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "unlisted" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({
      action: "upsert",
      id: "mgr-was-unlisted",
      status: "live",
      propertyData: { id: "mgr-was-unlisted" },
    });

    expect(res.status).toBe(403);
    // The unlisted row is untouched and still theirs to relist after upgrading.
    expect(UPSERTS).toEqual([]);
    expect(DELETED_IDS).toEqual([]);
  });

  it("answers 500, not 200, when the door count cannot be read", async () => {
    // A failed read must never be read as "zero doors used" — that would wave the
    // write through on exactly the transient error the cap exists to survive.
    COUNT_ERROR = { message: "connection terminated unexpectedly" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_DOOR_CAP);

    const res = await post({ action: "upsert", id: "mgr-x", status: "live", propertyData: {} });

    expect(res.status).toBe(500);
    expect(UPSERTS).toEqual([]);
  });

  it("answers 500, not a Free refusal, when the PLAN cannot be read", async () => {
    // Regression: quota-tier-read-fails-to-free. The purchase-row read used to
    // discard its PostgREST error, so a transient failure returned zero rows,
    // which resolves to "free" — a paying Business manager with many listings
    // was refused their next one with the Free copy. The gate fails closed
    // the same way now.
    TIER_READ_ERROR = "Could not read this account's plan.";
    SLOT_ROWS = liveRows(FREE_MANAGER, 50);

    const res = await post({ action: "upsert", id: "mgr-x", status: "live", propertyData: {} });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.error).toBe("Could not read this account's plan.");
    expect(body.code).toBeUndefined();
    expect(body.error).not.toContain("Free includes");
    expect(UPSERTS).toEqual([]);
    expect(DELETED_IDS).toEqual([]);
  });

  it("still lets an unreadable plan edit and unlist what it already has", async () => {
    // Fail-closed must not become "the portfolio is frozen": a write that does
    // not take a NEW slot never consults the plan at all.
    TIER_READ_ERROR = "Could not read this account's plan.";
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };

    const edit = await post({ action: "upsert", id: "mgr-existing", status: "live", propertyData: {} });
    const unlist = await post({ action: "upsert", id: "mgr-existing", status: "unlisted", rowData: {} });

    expect(edit.status).toBe(200);
    expect(unlist.status).toBe(200);
  });
});

/**
 * The rule the whole feature turns on: block CREATION, never destroy or hide.
 * A manager can be over the cap because they were seeded that way, downgraded
 * from Pro, or let past by the missing check this file exists to close. None of
 * that may cost them a listing.
 */
describe("A manager already OVER the door cap keeps every listing they have", () => {
  const OVER_BY = FREE_DOOR_CAP + 4;

  beforeEach(() => {
    SLOT_ROWS = liveRows(FREE_MANAGER, OVER_BY);
  });

  it("still saves an edit to an existing live listing", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };

    const res = await post({
      action: "upsert",
      id: `${FREE_MANAGER}-listing-3`,
      status: "live",
      propertyData: { id: `${FREE_MANAGER}-listing-3`, rentLabel: "$2,000" },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("still saves a PENDING listing that is already in a slot", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "pending" };

    const res = await post({
      action: "upsert",
      id: `${FREE_MANAGER}-listing-2`,
      status: "pending",
      rowData: { adminRefId: `${FREE_MANAGER}-listing-2` },
    });

    expect(res.status).toBe(200);
  });

  it("still lets them unlist one", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };

    const res = await post({
      action: "upsert",
      id: `${FREE_MANAGER}-listing-1`,
      status: "unlisted",
      rowData: { adminRefId: `${FREE_MANAGER}-listing-1` },
    });

    expect(res.status).toBe(200);
  });

  it("still lets them delete one", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };

    const res = await post({ action: "delete", id: `${FREE_MANAGER}-listing-1` });

    expect(res.status).toBe(200);
    expect(DELETED_IDS).toEqual([`${FREE_MANAGER}-listing-1`]);
  });

  it("refuses ONLY the additional listing, and deletes nothing on the way", async () => {
    const res = await post({ action: "upsert", id: "mgr-one-more", status: "live", propertyData: {} });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
    expect(DELETED_IDS).toEqual([]);
  });

  it("re-mirroring the whole over-limit portfolio writes every existing row", async () => {
    // `mirrorLocalPropertyPipelineToServer` re-upserts every locally known row
    // on load. For an over-limit account that is N live upserts in a row, and
    // every one of them must land.
    for (let i = 1; i <= OVER_BY; i += 1) {
      EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };
      const res = await post({
        action: "upsert",
        id: `${FREE_MANAGER}-listing-${i}`,
        status: "live",
        propertyData: { id: `${FREE_MANAGER}-listing-${i}` },
      });
      expect(res.status).toBe(200);
    }
    expect(UPSERTS).toHaveLength(OVER_BY);
  });
});

describe("Pro and Business are never refused for listing count — they price doors instead", () => {
  it("lets Pro publish well past Free's door cap", async () => {
    EFFECTIVE_TIER = "pro";
    SLOT_ROWS = liveRows(FREE_MANAGER, 50);

    const res = await post({ action: "upsert", id: "mgr-pro-51", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
  });

  it("never refuses Pro, no matter how many listings or doors it already holds", async () => {
    EFFECTIVE_TIER = "pro";
    SLOT_ROWS = liveRows(FREE_MANAGER, 500);

    const res = await post({
      action: "upsert",
      id: "mgr-pro-huge",
      status: "live",
      // A room-partitioned submission whose OWN doors alone would already
      // exceed any of the old per-tier caps — still never refused.
      propertyData: { id: "mgr-pro-huge", listingSubmission: { rooms: Array.from({ length: 40 }, () => ({ occupancyCapacity: 1 })) } },
    });

    expect(res.status).toBe(200);
  });

  it("lets Business publish well past Free's and Pro's old caps", async () => {
    EFFECTIVE_TIER = "business";
    SLOT_ROWS = liveRows(FREE_MANAGER, 500);

    const res = await post({ action: "upsert", id: "mgr-biz", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
  });

  it("leaves a legacy account with no committed plan uncapped", async () => {
    // `getEffectiveManagerSkuTier` returns null only when a live Stripe/Apple
    // grant backs an unrecognized tier. No numeric cap → no refusal.
    EFFECTIVE_TIER = null;
    SLOT_ROWS = liveRows(FREE_MANAGER, 50);

    const res = await post({ action: "upsert", id: "mgr-legacy", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
  });
});
