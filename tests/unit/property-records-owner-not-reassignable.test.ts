/**
 * `POST /api/property-records` used to let an ADMIN caller move an EXISTING
 * listing between managers, because the owner it wrote was
 * `body.managerUserId || existingOwnerId || user.id` — the request body won.
 *
 * Every client that posts here mirrors `managerUserId` straight out of a
 * browser-local pipeline bucket (`mirrorLocalPropertyPipelineToServer`,
 * `mirrorAdminPropertyRecord`, `promoteLegacyPendingListingsToLive`), so a stale
 * local bucket keyed by an old/other user id silently handed live listings to
 * that account. That is exactly what emptied a real manager's Properties tab:
 * the GET scopes strictly by `manager_user_id`, so the tab read 0/0/0, while
 * Residents, Applications, and the Communication property filter — which read
 * denormalized property labels off application/lease rows
 * (`propertyOptionsFromContacts`) — kept listing the same houses.
 *
 * Ownership changes now have exactly one door: `transferPropertyOwnership`
 * (requires an accepted co-manager link, notifies both sides).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let IS_ADMIN = false;
/**
 * Faithful to the SELECT the route issues (`manager_user_id, status`). The
 * status matters: the plan property-limit gate charges only a write that moves
 * a record INTO a listing slot, so an already-live listing being re-saved — the
 * shape every case below models — is never re-charged and never reaches the
 * quota count. Omitting it made these ownership cases look like publishes.
 */
let EXISTING_ROW: {
  manager_user_id: string;
  status?: string;
  row_data?: unknown;
  property_data?: unknown;
} | null = null;
let UPSERTS: Record<string, unknown>[] = [];
let DELETED_IDS: string[] = [];
let CO_MANAGER_ACCESS: { ok: true } | { ok: false; error: string; status: number } = {
  ok: false,
  error: "Forbidden.",
  status: 403,
};

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => IS_ADMIN }));
/**
 * These accounts have no `manager_purchases` row, so the plan gate resolves no
 * numeric cap and the real quota code returns without counting anything. That
 * keeps this file about OWNERSHIP while leaving the gate itself in the path —
 * the cap has its own file, `property-records-plan-property-limit.test.ts`.
 */
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: null }),
}));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => CO_MANAGER_ACCESS,
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: EXISTING_ROW, error: null }) }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        UPSERTS.push(row);
        // Faithful to the column: `manager_user_id` is a uuid, and Postgres
        // REJECTS a blank one rather than coercing it to null. Emulating that
        // is what makes the orphaned-listing 500 reproducible here — a mock
        // that accepts anything reports a cheerful 200 on a save that dies in
        // production.
        if (row.manager_user_id === "") {
          return { error: { message: 'invalid input syntax for type uuid: ""' } };
        }
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

const OWNER = "mgr-real-owner";
const OTHER_MANAGER = "mgr-legacy-account";
const ADMIN = "admin-1";
const CO_MANAGER = "mgr-co-1";
const PROPERTY_ID = "mgr-demo-cascade";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  IS_ADMIN = false;
  EXISTING_ROW = { manager_user_id: OWNER, status: "live" };
  UPSERTS = [];
  DELETED_IDS = [];
  CO_MANAGER_ACCESS = { ok: false, error: "Forbidden.", status: 403 };
});

describe("POST /api/property-records — an existing listing's owner is not caller-supplied", () => {
  it("ignores a foreign managerUserId from an ADMIN and keeps the stored owner", async () => {
    IS_ADMIN = true;
    getUser.mockResolvedValue({ data: { user: { id: ADMIN } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: OTHER_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID, managerUserId: OTHER_MANAGER },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });

  it("ignores a foreign managerUserId from the OWNER's own client", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: OTHER_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });

  it("keeps the owner when a permitted co-manager edits the listing", async () => {
    CO_MANAGER_ACCESS = { ok: true };
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: CO_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });

  it("still refuses a co-manager without the properties module", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: {} });

    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });
});

describe("POST /api/property-records — creating a record still attributes normally", () => {
  it("lets an admin create a NEW record on a manager's behalf", async () => {
    IS_ADMIN = true;
    EXISTING_ROW = null;
    getUser.mockResolvedValue({ data: { user: { id: ADMIN } } });

    const res = await post({
      action: "upsert",
      id: "mgr-brand-new",
      managerUserId: OWNER,
      status: "live",
      propertyData: { id: "mgr-brand-new" },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });

  it("refuses a non-admin creating a record owned by someone else", async () => {
    EXISTING_ROW = null;
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({
      action: "upsert",
      id: "mgr-brand-new",
      managerUserId: OWNER,
      status: "live",
      propertyData: {},
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("keeps delete authorized by the stored owner, not the body", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({ action: "delete", id: PROPERTY_ID, managerUserId: CO_MANAGER });

    expect(res.status).toBe(403);
    expect(DELETED_IDS).toHaveLength(0);
  });
});

/**
 * `manager_user_id` is `references auth.users (id) on delete set null`, so an
 * EXISTING row with a blank owner is a reachable production state, and the row
 * id is the public listing id. Treating that row as a create would let any
 * signed-in account take over — or destroy — the listing.
 */
describe("POST /api/property-records — an EXISTING ownerless row is not a create", () => {
  beforeEach(() => {
    EXISTING_ROW = { manager_user_id: "", status: "live" };
  });

  it("refuses a non-admin upsert onto an orphaned listing", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OTHER_MANAGER } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: OTHER_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a non-admin delete of an orphaned listing and deletes nothing", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OTHER_MANAGER } } });

    const res = await post({ action: "delete", id: PROPERTY_ID });

    expect(res.status).toBe(403);
    expect(DELETED_IDS).toHaveLength(0);
  });

  it("lets an admin adopt an orphaned listing on a manager's behalf", async () => {
    IS_ADMIN = true;
    getUser.mockResolvedValue({ data: { user: { id: ADMIN } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: OWNER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });

  /**
   * The co-manager branch preserved the stored owner verbatim, and on an
   * orphaned row that value is `""`. An empty string is not a uuid, so Postgres
   * rejected the whole upsert and an ORDINARY save — a permitted co-manager
   * editing a listing they have the `properties` edit grant on — came back 500.
   */
  it("lets a permitted co-manager save an orphaned listing instead of erroring", async () => {
    CO_MANAGER_ACCESS = { ok: true };
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: CO_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(res.status).toBe(200);
    // The row stays ownerless — writing `""` is what broke, and writing
    // `CO_MANAGER` would be the silent adoption this route was hardened against.
    expect(UPSERTS[0].manager_user_id).toBeNull();
  });

  it("does not let a permitted co-manager adopt the orphaned listing", async () => {
    CO_MANAGER_ACCESS = { ok: true };
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: CO_MANAGER,
      status: "live",
      propertyData: { id: PROPERTY_ID },
    });

    expect(UPSERTS[0].manager_user_id).not.toBe(CO_MANAGER);
    expect(UPSERTS[0].manager_user_id).not.toBe("");
  });

  it("never sends a blank uuid for any caller who reaches the upsert", async () => {
    // The chokepoint before the write: whatever branch resolved the owner, the
    // value handed to a uuid column is a uuid or `null`, never `""`.
    for (const caller of [ADMIN, CO_MANAGER]) {
      UPSERTS = [];
      IS_ADMIN = caller === ADMIN;
      CO_MANAGER_ACCESS = { ok: true };
      getUser.mockResolvedValue({ data: { user: { id: caller } } });

      const res = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: {} });

      expect(res.status).toBe(200);
      expect(UPSERTS[0].manager_user_id === null || typeof UPSERTS[0].manager_user_id === "string").toBe(true);
      expect(UPSERTS[0].manager_user_id).not.toBe("");
    }
  });

  it("preserves stored row_data when a mirror upsert sends only propertyData", async () => {
    EXISTING_ROW = {
      manager_user_id: OWNER,
      status: "live",
      row_data: { id: PROPERTY_ID, name: "Ballard House", status: "live" },
      property_data: { id: PROPERTY_ID, title: "Old title" },
    };
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });

    await post({
      action: "upsert",
      id: PROPERTY_ID,
      status: "live",
      propertyData: { id: PROPERTY_ID, title: "Ballard House" },
    });

    expect(UPSERTS[0].row_data).toEqual({
      id: PROPERTY_ID,
      name: "Ballard House",
      status: "live",
    });
    expect(UPSERTS[0].property_data).toEqual({ id: PROPERTY_ID, title: "Ballard House" });
  });
});
