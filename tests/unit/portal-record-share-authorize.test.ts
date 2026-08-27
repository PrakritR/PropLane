/**
 * Minting a share link for a record whose owner column was never stamped.
 *
 * `portal_record_share_links.manager_user_id` is what every public read of the link is later
 * scoped to, so the mint has to know the portfolio owner. Older lease and application rows can
 * carry a NULL `manager_user_id` while still belonging to a property that has one — the mint used
 * to hand that NULL straight to the insert, and the manager saw a bare "Failed to create share
 * link." with nothing to act on. `authorizePortalRecordShare` now falls back to the property's
 * owner, and a genuinely unresolvable owner is a 400 that says so rather than a 500.
 *
 * The second failure this covers is environmental: on a database where the
 * `portal_record_share_links` migrations have not been applied, PostgREST answers PGRST205, which
 * also surfaced as the same opaque 500. It is now a 503 naming the command that fixes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const isAdmin = vi.fn();
const leaseAccess = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdmin(...a) }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerCanAccessLeaseRecord: (...a: unknown[]) => leaseAccess(...a),
}));
vi.mock("@/lib/auth/manager-application-access", () => ({
  managerCanAccessApplicationRecord: async () => false,
}));

let authedUserId: string | null = "mgr-1";
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authedUserId ? { id: authedUserId } : null } }) },
  }),
}));

type LeaseRow = { id: string; manager_user_id: string | null; property_id: string | null; row_data: unknown };

let leaseRow: LeaseRow | null = null;
let propertyOwners: Record<string, string | null> = {};
/** Set to a PostgREST error to simulate a project missing the share-link migrations. */
let shareLinkInsertError: { message: string; code?: string } | null = null;
let insertedShareRow: Record<string, unknown> | null = null;

function fakeServiceClient() {
  return {
    from(table: string) {
      if (table === "portal_lease_pipeline_records") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: leaseRow, error: null }) }) }),
        };
      }
      if (table === "manager_property_records") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) => ({
              not: () => ({
                limit: async () => {
                  const owner = ids.map((id) => propertyOwners[id]).find(Boolean) ?? null;
                  return { data: owner ? [{ manager_user_id: owner }] : [], error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "portal_record_share_links") {
        return {
          insert: (row: Record<string, unknown>) => {
            insertedShareRow = row;
            return {
              select: () => ({
                single: async () =>
                  shareLinkInsertError
                    ? { data: null, error: shareLinkInsertError }
                    : {
                        data: {
                          id: "share-1",
                          record_kind: row.record_kind,
                          record_id: row.record_id,
                          share_token: row.share_token,
                          expires_at: row.expires_at,
                          created_at: "2026-08-27T00:00:00.000Z",
                          revoked_at: null,
                          access_count: 0,
                        },
                        error: null,
                      },
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => fakeServiceClient() }));

const { POST } = await import("@/app/api/portal/record-share-link/route");

const mint = (body: Record<string, unknown>) =>
  POST(
    new Request("https://prop-lane.space/api/portal/record-share-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  authedUserId = "mgr-1";
  isAdmin.mockReset().mockResolvedValue(false);
  leaseAccess.mockReset().mockResolvedValue(true);
  shareLinkInsertError = null;
  insertedShareRow = null;
  propertyOwners = { "prop-9": "mgr-1" };
  leaseRow = {
    id: "lease-77",
    manager_user_id: null,
    property_id: "prop-9",
    row_data: { residentName: "Jordan Rivera", propertyId: "prop-9" },
  };
});

describe("a lease row with no stamped owner", () => {
  it("mints the link against the property's owner instead of failing", async () => {
    const res = await mint({ kind: "lease", recordId: "lease-77", expiresInDays: 90 });
    const body = (await res.json()) as { link?: { url?: string } };

    expect(res.status).toBe(200);
    expect(body.link?.url).toMatch(/\/share\/leases\//);
    expect(insertedShareRow?.manager_user_id).toBe("mgr-1");
  });

  it("falls back to row_data.propertyId when the column itself is empty", async () => {
    leaseRow = {
      id: "lease-77",
      manager_user_id: null,
      property_id: null,
      row_data: { residentName: "Jordan Rivera", propertyId: "prop-9" },
    };

    const res = await mint({ kind: "lease", recordId: "lease-77" });
    expect(res.status).toBe(200);
    expect(insertedShareRow?.manager_user_id).toBe("mgr-1");
  });

  it("says the owner could not be resolved rather than answering a bare 500", async () => {
    propertyOwners = {};
    const res = await mint({ kind: "lease", recordId: "lease-77" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Could not resolve lease owner for this link." });
    expect(insertedShareRow).toBeNull();
  });
});

describe("what it still refuses", () => {
  it("403s a manager who cannot edit the lease", async () => {
    leaseAccess.mockResolvedValue(false);
    const res = await mint({ kind: "lease", recordId: "lease-77" });
    expect(res.status).toBe(403);
    expect(insertedShareRow).toBeNull();
  });

  it("rejects a record id outside the safe id charset", async () => {
    const res = await mint({ kind: "lease", recordId: "lease-77/../other" });
    expect(res.status).toBe(400);
    expect(insertedShareRow).toBeNull();
  });

  it("401s an unauthenticated caller", async () => {
    authedUserId = null;
    const res = await mint({ kind: "lease", recordId: "lease-77" });
    expect(res.status).toBe(401);
  });
});

describe("an environment missing the share-link migrations", () => {
  it("answers 503 naming the command that fixes it", async () => {
    shareLinkInsertError = {
      message: "Could not find the table 'public.portal_record_share_links' in the schema cache",
      code: "PGRST205",
    };
    const res = await mint({ kind: "lease", recordId: "lease-77" });
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(503);
    expect(body.error).toContain("npm run db:apply-sql");
  });
});
