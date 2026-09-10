/**
 * The Free plan advertises "1 property listing" (`MANAGER_PLAN_TIERS`), and
 * until now that was a sentence on a pricing card. The cap existed ONLY in the
 * browser — `manager-properties.tsx` disabled "+ Add property" and
 * `manager-add-listing-form.tsx` refused to submit — while
 * `POST /api/property-records` was a plain upsert with no tier check at all.
 * Every client posts to that route directly, so publishing a second, fifth or
 * fiftieth listing on Free needed nothing more than skipping the interface
 * (manager-portal audit, F-SET-1).
 *
 * What this file pins down:
 *
 * 1. A free-plan manager is refused a SECOND listing, by the server, with a
 *    message that names the limit and the plans that lift it.
 * 2. The refusal does not depend on the interface — it is the same request,
 *    with no client state involved, and the body cannot argue its way past it.
 * 3. A manager already OVER the limit keeps their listings. Editing, unlisting
 *    and deleting an existing row all still work; only an ADDITIONAL slot is
 *    refused. Nothing here ever removes a record.
 * 4. A paid-plan manager is unaffected within their own, larger cap.
 * 5. Drafts and unlisted rows are not listings and are never charged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";
import { BUSINESS_MAX_PROPERTIES, FREE_MAX_PROPERTIES, PRO_MAX_PROPERTIES } from "@/lib/manager-access";

const getUser = vi.fn();

let EFFECTIVE_TIER: string | null = "free";
let EXISTING_ROW: { manager_user_id: string; status?: string } | null = null;
/** Rows the owner already holds, as the route's count query would see them. */
let SLOT_ROWS: Array<{ id: string; manager_user_id: string; status: string }> = [];
let COUNT_ERROR: { message: string } | null = null;
/** The plan read itself failing — distinct from the account having no plan. */
let TIER_READ_ERROR: string | null = null;
let UPSERTS: Record<string, unknown>[] = [];
let DELETED_IDS: string[] = [];
/** Every filter the count query applied, so the test can prove HOW it counted. */
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
    from: (table: string) => ({
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (!opts?.count) {
          return {
            eq: () => ({ maybeSingle: async () => ({ data: EXISTING_ROW, error: null }) }),
          };
        }
        // The listing-slot count: .eq(manager_user_id).in(status).neq(id)
        const filters: Record<string, unknown> = {};
        COUNT_FILTERS.push(filters);
        const rowsFor = () => {
          let rows = SLOT_ROWS;
          if (typeof filters.owner === "string") {
            rows = rows.filter((r) => r.manager_user_id === filters.owner);
          }
          if (Array.isArray(filters.statuses)) {
            rows = rows.filter((r) => (filters.statuses as string[]).includes(r.status));
          }
          if (typeof filters.excludeId === "string") {
            rows = rows.filter((r) => r.id !== filters.excludeId);
          }
          return rows;
        };
        const builder = {
          eq(_col: string, value: string) {
            filters.owner = value;
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
          then(resolve: (v: { count: number | null; error: unknown }) => unknown) {
            return Promise.resolve(
              COUNT_ERROR ? { count: null, error: COUNT_ERROR } : { count: rowsFor().length, error: null },
            ).then(resolve);
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
    }),
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

describe("Free plan — a second property listing is refused by the server", () => {
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

  it("refuses the SECOND, and says what the limit is and what lifts it", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    const res = await post({
      action: "upsert",
      id: "mgr-second",
      status: "live",
      propertyData: { id: "mgr-second" },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; limit: number; tier: string };
    expect(body.code).toBe("property_limit_reached");
    expect(body.limit).toBe(FREE_MAX_PROPERTIES);
    expect(body.tier).toBe("free");
    // Not an opaque error: the sentence names the plan, the number, and the way past it.
    expect(body.error).toContain(`Free includes ${FREE_MAX_PROPERTIES} property`);
    expect(body.error).toContain("Upgrade to Pro or Business");
    // And nothing was written.
    expect(UPSERTS).toEqual([]);
  });

  it("holds when the request bypasses the interface entirely", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

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

  it("counts the owner the SERVER resolved, and excludes the row being written", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    await post({ action: "upsert", id: "mgr-x", status: "live", propertyData: {} });

    expect(COUNT_FILTERS).toHaveLength(1);
    expect(COUNT_FILTERS[0]).toMatchObject({ owner: FREE_MANAGER, excludeId: "mgr-x" });
  });

  it("cannot be handed someone else's larger allowance through the body", async () => {
    // `managerUserId` is the value this route was already hardened against
    // trusting; the cap must not have reintroduced it as a way to be counted
    // against a different — emptier — account.
    SLOT_ROWS = [...liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES), ...liveRows(OTHER_MANAGER, 0)];

    const res = await post({
      action: "upsert",
      id: "mgr-x",
      managerUserId: OTHER_MANAGER,
      status: "live",
      propertyData: {},
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
    // Whatever the body said, no count was ever taken against that account.
    expect(COUNT_FILTERS.some((f) => f.owner === OTHER_MANAGER)).toBe(false);
  });

  it("counts only listing slots — drafts and unlisted rows never fill the plan", async () => {
    SLOT_ROWS = [
      ...liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES),
      { id: "d1", manager_user_id: FREE_MANAGER, status: "draft" },
      { id: "u1", manager_user_id: FREE_MANAGER, status: "unlisted" },
    ];

    await post({ action: "upsert", id: "mgr-x", status: "live", propertyData: {} });

    expect(COUNT_FILTERS[0]?.statuses).toEqual(["pending", "live", "review"]);
  });

  it("does not charge a draft save, however many drafts already exist", async () => {
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    const res = await post({
      action: "upsert",
      id: "mgr-draft-9",
      status: "draft",
      rowData: { adminRefId: "mgr-draft-9" },
    });

    expect(res.status).toBe(200);
    // A draft is private and unpublished — the cap was never consulted.
    expect(COUNT_FILTERS).toEqual([]);
  });

  it("does not charge unlisting a live listing", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "live" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    const res = await post({
      action: "upsert",
      id: "mgr-first",
      status: "unlisted",
      rowData: { adminRefId: "mgr-first" },
    });

    expect(res.status).toBe(200);
    expect(COUNT_FILTERS).toEqual([]);
  });

  it("refuses publishing a saved DRAFT into a filled plan", async () => {
    // The wizard publishes a resumed draft by re-upserting the SAME id
    // draft → live, so the row exists. That is still a new listing slot.
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "draft" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    const res = await post({
      action: "upsert",
      id: "mgr-saved-draft",
      status: "live",
      propertyData: { id: "mgr-saved-draft" },
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toEqual([]);
  });

  it("refuses RELISTING an unlisted row into a filled plan", async () => {
    EXISTING_ROW = { manager_user_id: FREE_MANAGER, status: "unlisted" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

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

  it("answers 500, not 200, when the slot count cannot be read", async () => {
    // A failed count must never be read as "zero used" — that would wave the
    // write through on exactly the transient error the cap exists to survive.
    COUNT_ERROR = { message: "connection terminated unexpectedly" };
    SLOT_ROWS = liveRows(FREE_MANAGER, FREE_MAX_PROPERTIES);

    const res = await post({ action: "upsert", id: "mgr-x", status: "live", propertyData: {} });

    expect(res.status).toBe(500);
    expect(UPSERTS).toEqual([]);
  });

  it("answers 500, not a Free refusal, when the PLAN cannot be read", async () => {
    // Regression: quota-tier-read-fails-to-free. The purchase-row read used to
    // discard its PostgREST error, so a transient failure returned zero rows,
    // which resolves to "free" — a paying Business manager with five listings
    // was refused their sixth with the Free copy. The two halves of the gate
    // fail closed the same way now.
    TIER_READ_ERROR = "Could not read this account's plan.";
    SLOT_ROWS = liveRows(FREE_MANAGER, BUSINESS_MAX_PROPERTIES - 1);

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
describe("A manager already OVER the limit keeps every listing they have", () => {
  const OVER_BY = FREE_MAX_PROPERTIES + 4;

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
    // An already-live row is not re-charged, so the cap was never even counted.
    expect(COUNT_FILTERS).toEqual([]);
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

describe("Paid plans are unaffected inside their own cap", () => {
  it("lets Pro publish up to its advertised limit", async () => {
    EFFECTIVE_TIER = "pro";
    SLOT_ROWS = liveRows(FREE_MANAGER, PRO_MAX_PROPERTIES - 1);

    const res = await post({ action: "upsert", id: "mgr-pro-2", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
  });

  it("refuses Pro past its limit, pointing at Business", async () => {
    EFFECTIVE_TIER = "pro";
    SLOT_ROWS = liveRows(FREE_MANAGER, PRO_MAX_PROPERTIES);

    const res = await post({ action: "upsert", id: "mgr-pro-3", status: "live", propertyData: {} });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; limit: number };
    expect(body.limit).toBe(PRO_MAX_PROPERTIES);
    expect(body.error).toContain("Upgrade to Business");
  });

  it("lets Business publish well past the Free and Pro caps", async () => {
    EFFECTIVE_TIER = "business";
    SLOT_ROWS = liveRows(FREE_MANAGER, BUSINESS_MAX_PROPERTIES - 1);

    const res = await post({ action: "upsert", id: "mgr-biz", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
  });

  it("leaves a legacy account with no committed plan uncapped", async () => {
    // `getEffectiveManagerSkuTier` returns null only when a live Stripe/Apple
    // grant backs an unrecognized tier. No numeric cap → no count, no refusal.
    EFFECTIVE_TIER = null;
    SLOT_ROWS = liveRows(FREE_MANAGER, 50);

    const res = await post({ action: "upsert", id: "mgr-legacy", status: "live", propertyData: {} });

    expect(res.status).toBe(200);
    expect(COUNT_FILTERS).toEqual([]);
  });
});
