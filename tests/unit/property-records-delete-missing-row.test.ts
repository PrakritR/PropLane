/**
 * `POST /api/property-records` with `action: "delete"` and an id that has NO
 * `manager_property_records` row used to fall into the CREATE branch.
 *
 * That branch exists to attribute a brand-new record, so it has no stored owner
 * to authorize against: `ownerForWrite = body.managerUserId?.trim() || user.id`,
 * and its 403 only fires when the caller NAMES someone else. A caller who simply
 * omitted `managerUserId` was waved through with no permission check at all —
 * and the delete branch then ran `clearHousingAccessForDeletedProperty(db, id)`
 * with the SERVICE-ROLE client.
 *
 * That helper is globally scoped. It reads every row of `account_link_invites`
 * and `portal_pro_relationship_records`, queries `manager_application_records`
 * by the caller-supplied id, and REWRITES every match — stripping co-manager
 * grants and scrubbing residents' housing/placement fields to "Moved out" —
 * across EVERY manager. So any signed-in account could aim a privileged,
 * destructive, portfolio-wide cleanup at an arbitrary id, precisely BECAUSE the
 * row did not exist. It compounded: ids used to match through a normalizing
 * token rather than an exact string, so even a fully authorized delete of a
 * record the caller had just created could fold onto a victim's id. Ids now
 * match EXACTLY, and that neighbouring step is covered by
 * `clear-property-housing-access-exact-id-match.test.ts`.
 *
 * A delete of something that is not there must authorize and then do nothing.
 * The route now refuses a missing row as 404 before owner resolution, so the
 * cleanup helper is reachable only after `existing` is a real row and the
 * authorization below it has passed on that row.
 *
 * Sibling of `property-records-owner-not-reassignable.test.ts`, which guards the
 * other half of this route's authorization (a stored owner is never
 * caller-supplied). Both must hold.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
const clearHousingAccess = vi.fn(async () => ({ invitesUpdated: 0, applicationsCleared: 0 }));

let IS_ADMIN = false;
let EXISTING_ROW: { manager_user_id: string } | null = null;
let EXISTING_READ_ERROR: { message: string } | null = null;
let CO_MANAGER_ACCESS: { ok: true } | { ok: false; error: string; status: number } = {
  ok: false,
  error: "Forbidden.",
  status: 403,
};

/** Every mutating statement the request issued, whatever table it targeted. */
let WRITES: Array<{ table: string; op: "upsert" | "delete" | "update"; id?: string }> = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => IS_ADMIN }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => CO_MANAGER_ACCESS,
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: (...args: unknown[]) =>
    (clearHousingAccess as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: EXISTING_READ_ERROR ? null : EXISTING_ROW,
            error: EXISTING_READ_ERROR,
          }),
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        WRITES.push({ table, op: "upsert", id: String(row.id ?? "") });
        return { error: null };
      },
      delete: () => ({
        eq: async (_col: string, value: string) => {
          WRITES.push({ table, op: "delete", id: value });
          return { error: null };
        },
      }),
      update: () => ({
        eq: async (_col: string, value: string) => {
          WRITES.push({ table, op: "update", id: value });
          return { error: null };
        },
      }),
    }),
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

const OWNER = "mgr-real-owner";
const OUTSIDER = "mgr-unrelated-account";
const ADMIN = "admin-1";
const CO_MANAGER = "mgr-co-1";
const OWNED_PROPERTY_ID = "mgr-owned-listing";
/** An id the caller made up. No row has ever existed under it. */
const ARBITRARY_ID = "mgr-someone-elses-house-1234";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  IS_ADMIN = false;
  EXISTING_ROW = null;
  EXISTING_READ_ERROR = null;
  CO_MANAGER_ACCESS = { ok: false, error: "Forbidden.", status: 403 };
  WRITES = [];
});

describe("POST /api/property-records — deleting a row that does not exist", () => {
  it("refuses an unauthorized caller's arbitrary id and never reaches the global cleanup", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OUTSIDER } } });

    const res = await post({ action: "delete", id: ARBITRARY_ID });

    // Asserted FIRST, on purpose: this is the finding. When the guard is
    // removed this test must fail by NAMING the privileged helper, not by
    // reporting an unexpected status code.
    expect(clearHousingAccess).not.toHaveBeenCalled();
    // And the request produced no mutating statement of any kind.
    expect(WRITES).toEqual([]);
    expect(res.status).toBe(404);
  });

  it("still refuses when the caller names THEMSELVES as the owner", async () => {
    // The create branch's only 403 fires on a FOREIGN `managerUserId`. Naming
    // yourself satisfied it, which is how the hole was reachable at all — so
    // this is the exact request the old code let through.
    getUser.mockResolvedValue({ data: { user: { id: OUTSIDER } } });

    const res = await post({ action: "delete", id: ARBITRARY_ID, managerUserId: OUTSIDER });

    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
    expect(res.status).toBe(404);
  });

  it("refuses even for an admin, so the helper is unreachable without a real row", async () => {
    IS_ADMIN = true;
    getUser.mockResolvedValue({ data: { user: { id: ADMIN } } });

    const res = await post({ action: "delete", id: ARBITRARY_ID });

    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
    expect(res.status).toBe(404);
  });

  it("refuses a co-manager who holds the delete grant, because there is nothing to delete", async () => {
    CO_MANAGER_ACCESS = { ok: true };
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({ action: "delete", id: ARBITRARY_ID });

    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
    expect(res.status).toBe(404);
  });

  it("still answers 401 before any of this when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const res = await post({ action: "delete", id: ARBITRARY_ID });

    expect(res.status).toBe(401);
    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
  });
});

describe("POST /api/property-records — a legitimate delete still works end to end", () => {
  beforeEach(() => {
    EXISTING_ROW = { manager_user_id: OWNER };
  });

  it("lets the owner delete their own listing and runs the housing cleanup once", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(WRITES).toEqual([
      { table: "manager_property_records", op: "delete", id: OWNED_PROPERTY_ID },
    ]);
    expect(clearHousingAccess).toHaveBeenCalledTimes(1);
    expect(clearHousingAccess.mock.calls[0][1]).toBe(OWNED_PROPERTY_ID);
  });

  it("lets an admin delete an existing listing", async () => {
    IS_ADMIN = true;
    getUser.mockResolvedValue({ data: { user: { id: ADMIN } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(res.status).toBe(200);
    expect(clearHousingAccess).toHaveBeenCalledTimes(1);
  });

  it("lets a co-manager with the delete grant delete the linked owner's listing", async () => {
    CO_MANAGER_ACCESS = { ok: true };
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(res.status).toBe(200);
    expect(clearHousingAccess).toHaveBeenCalledTimes(1);
  });

  it("refuses a co-manager without the grant, and the cleanup stays unreached", async () => {
    getUser.mockResolvedValue({ data: { user: { id: CO_MANAGER } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(res.status).toBe(403);
    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
  });

  /**
   * An EXISTING row whose owner is blank (`manager_user_id` is
   * `on delete set null`) is not a create either — it routes through the
   * co-manager gate like any other row it is not yours.
   */
  it("refuses an outsider deleting an EXISTING orphaned listing", async () => {
    EXISTING_ROW = { manager_user_id: "" };
    getUser.mockResolvedValue({ data: { user: { id: OUTSIDER } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(res.status).toBe(403);
    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
  });
});

/**
 * A read that FAILED is not a row that is absent. Answering 404 there would be
 * read by the client as success — `deletePropertyRecordFromServer` maps 404 to
 * `true`, and `deleteManagerPropertyDraft` then drops the local drafts row and
 * permanently deletes the draft's `listing-photos` objects while the server row
 * is still there. Taking the create branch instead would resolve an owner with
 * no stored owner to authorize against.
 */
describe("POST /api/property-records — the stored-row lookup fails", () => {
  beforeEach(() => {
    EXISTING_READ_ERROR = { message: "connection terminated unexpectedly" };
  });

  it("answers 500 on a delete rather than 404, and never reaches the global cleanup", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });

    const res = await post({ action: "delete", id: OWNED_PROPERTY_ID });

    expect(clearHousingAccess).not.toHaveBeenCalled();
    expect(WRITES).toEqual([]);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "connection terminated unexpectedly" });
  });

  it("answers 500 on an upsert rather than creating a record under the caller", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OUTSIDER } } });

    const res = await post({
      action: "upsert",
      id: OWNED_PROPERTY_ID,
      status: "live",
      propertyData: {},
    });

    expect(res.status).toBe(500);
    expect(WRITES).toEqual([]);
  });
});

/**
 * An `upsert` of a brand-new id is still a create — refusing a MISSING row must
 * not have turned every first save into a 404.
 */
describe("POST /api/property-records — creating a brand-new record is untouched", () => {
  it("lets a manager create a record under a new id", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });

    const res = await post({
      action: "upsert",
      id: "mgr-brand-new",
      status: "draft",
      rowData: { adminRefId: "mgr-brand-new" },
    });

    expect(res.status).toBe(200);
    expect(WRITES).toEqual([{ table: "manager_property_records", op: "upsert", id: "mgr-brand-new" }]);
  });

  it("still refuses a non-admin creating a record owned by someone else", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OUTSIDER } } });

    const res = await post({
      action: "upsert",
      id: "mgr-brand-new",
      managerUserId: OWNER,
      status: "live",
      propertyData: {},
    });

    expect(res.status).toBe(403);
    expect(WRITES).toEqual([]);
  });
});
