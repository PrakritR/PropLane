import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { profileRolesBuilder } from "../../helpers/profile-roles-fake";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: vi.fn().mockResolvedValue(undefined) }));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { prepareDispatch } from "@/lib/work-order-dispatch.server";
import { POST } from "@/app/api/portal-work-orders/route";

type Rec = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  row_data: Record<string, unknown>;
};

/** A residency row; the resident is bound by their Auth subject (`row_data.residentUserId`). */
type AppSeed = { manager_user_id: string; resident_email: string; resident_user_id?: string; property_id?: string };

/** Same shape as the sibling portal-work-orders mock, plus emulation of the
 * `dispatch:row_data->dispatch` aliased selection the ownership lookup uses. */
function mockDb(
  seed: Rec[],
  profile: { email: string; role: string } | null,
  appSeed: AppSeed[] = [],
  roles: { user_id: string; role: string }[] = [],
) {
  const store = new Map(seed.map((r) => [r.id, r]));
  const upserts: Rec[] = [];

  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: profile }),
        };
      }
      if (table === "profile_roles") return profileRolesBuilder(roles);
      if (table === "manager_application_records") {
        const filters: Record<string, string> = {};
        const rows = () =>
          appSeed
            .map((a, i) => ({
              id: `APP-${i}`,
              manager_user_id: a.manager_user_id,
              resident_email: a.resident_email,
              property_id: a.property_id ?? null,
              assigned_property_id: null,
              row_data: { bucket: "approved", residentUserId: a.resident_user_id ?? null, propertyId: a.property_id ?? null },
              updated_at: "x",
            }))
            .filter((a) =>
              Object.entries(filters).every(([col, val]) =>
                col === "row_data->>residentUserId"
                  ? a.row_data.residentUserId === val
                  : (a as unknown as Record<string, unknown>)[col] === val,
              ),
            );
        const builder: Record<string, unknown> = {
          select: () => builder,
          order: () => builder,
          eq: (col: string, val: string) => {
            filters[col] = val;
            return builder;
          },
          limit: async () => ({ data: rows(), error: null }),
          then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
        };
        return builder;
      }
      if (table === "manager_vendor_records") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
        };
      }
      // Filter-collecting builder: ownership lookups terminate with .maybeSingle(), list reads are
      // awaited directly, and a write is an insert (new row) or a revision-guarded update (existing).
      // Only the work-order table holds rows here; every other table the route touches reads empty.
      const filters: { col: string; val: unknown }[] = [];
      const matches = () =>
        table === "portal_work_order_records"
          ? [...store.values()].filter((r) => filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val))
          : [];
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        is: () => chain,
        in: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val });
          return chain;
        },
        maybeSingle: async () => {
          const rec = matches()[0];
          if (!rec) return { data: null, error: null };
          return {
            data: {
              manager_user_id: rec.manager_user_id,
              resident_user_id: (rec as { resident_user_id?: string | null }).resident_user_id ?? null,
              resident_email: rec.resident_email,
              row_revision: 1,
              dispatch: (rec.row_data as { dispatch?: unknown }).dispatch ?? null,
              row_data: rec.row_data,
            },
            error: null,
          };
        },
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: [], error: null }),
        insert: async (rec: Rec) => {
          if (table === "portal_work_order_records") {
            upserts.push(rec);
            store.set(rec.id, rec);
          }
          return { error: null };
        },
        update: (rec: Rec) => {
          const guarded: Record<string, unknown> = {
            eq: () => guarded,
            select: async () => {
              if (table === "portal_work_order_records") {
                upserts.push(rec);
                store.set(rec.id, rec);
              }
              return { data: [{ id: rec.id }], error: null };
            },
          };
          return guarded;
        },
      };
      return chain;
    },
  };
  return { client, store, upserts };
}

function asUser(id: string, email: string) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id, email, user_metadata: {} } } }) },
  } as never);
}

const PROPOSAL = {
  status: "proposed",
  vendorId: "v1",
  vendorName: "Pipes R Us",
  reasoning: "r",
  candidates: [],
  guardrails: { approvedList: true, category: true, spendCap: "no_estimate" },
  proposedAtIso: "2026-07-15T00:00:00.000Z",
};

describe("work-order POST dispatch trigger + preserve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires prepareDispatch exactly once for a new resident row, not on re-sync", async () => {
    asUser("res-b", "res@b.com");
    const { client } = mockDb([], { email: "res@b.com", role: "resident" }, [
      { manager_user_id: "mgr-b", resident_email: "res@b.com", resident_user_id: "res-b", property_id: "prop-b" },
    ], [{ user_id: "res-b", role: "resident" }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const body = { action: "replace", rows: [{ id: "REQ-new", managerUserId: "mgr-b", residentEmail: "res@b.com", propertyId: "prop-b" }] };
    const first = await POST(jsonRequest("http://t", { method: "POST", body }));
    expect((await parseJsonResponse(first)).status).toBe(200);
    expect(vi.mocked(prepareDispatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepareDispatch)).toHaveBeenCalledWith(expect.anything(), "REQ-new");

    const replay = await POST(jsonRequest("http://t", { method: "POST", body }));
    expect((await parseJsonResponse(replay)).status).toBe(200);
    expect(vi.mocked(prepareDispatch)).toHaveBeenCalledTimes(1);
  });

  it("strips a forged dispatch off a new resident row so prepareDispatch still runs", async () => {
    asUser("res-b", "res@b.com");
    const { client, upserts } = mockDb([], { email: "res@b.com", role: "resident" }, [
      { manager_user_id: "mgr-b", resident_email: "res@b.com", resident_user_id: "res-b", property_id: "prop-b" },
    ], [{ user_id: "res-b", role: "resident" }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const body = {
      action: "replace",
      rows: [{ id: "REQ-forged", managerUserId: "mgr-b", residentEmail: "res@b.com", propertyId: "prop-b", dispatch: PROPOSAL }],
    };
    const res = await POST(jsonRequest("http://t", { method: "POST", body }));
    expect((await parseJsonResponse(res)).status).toBe(200);
    expect(vi.mocked(prepareDispatch)).toHaveBeenCalledTimes(1);
    const persisted = upserts[0]!.row_data as { dispatch?: unknown };
    expect("dispatch" in persisted).toBe(false);
  });

  it("does not fire for manager-created rows", async () => {
    asUser("mgr-a", "a@test.com");
    const { client } = mockDb([], { email: "a@test.com", role: "manager" }, [], [{ user_id: "mgr-a", role: "manager" }]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(jsonRequest("http://t", { method: "POST", body: { row: { id: "WO-mgr", title: "x" } } }));
    expect((await parseJsonResponse(res)).status).toBe(200);
    expect(vi.mocked(prepareDispatch)).not.toHaveBeenCalled();
  });

  it("preserves a server-side dispatch proposal when a client re-sync omits it", async () => {
    asUser("mgr-a", "a@test.com");
    const { client, upserts } = mockDb(
      [
        {
          id: "WO-a",
          manager_user_id: "mgr-a",
          resident_email: "res@a.com",
          row_data: { id: "WO-a", title: "A", dispatch: PROPOSAL },
        },
      ],
      { email: "a@test.com", role: "manager" },
      [],
      [{ user_id: "mgr-a", role: "manager" }],
    );
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", { method: "POST", body: { action: "replace", rows: [{ id: "WO-a", title: "A edited" }] } }),
    );
    expect((await parseJsonResponse(res)).status).toBe(200);
    const persisted = upserts[0]!.row_data as { title: string; dispatch?: { status: string } };
    expect(persisted.title).toBe("A edited");
    expect(persisted.dispatch?.status).toBe("proposed");
  });

  it("never lets an undecided client echo overwrite a decided dispatch", async () => {
    asUser("mgr-a", "a@test.com");
    const decided = { ...PROPOSAL, status: "approved", decidedAtIso: "2026-07-15T01:00:00.000Z", decidedBy: "manager" };
    const { client, upserts } = mockDb(
      [{ id: "WO-a", manager_user_id: "mgr-a", resident_email: null, row_data: { id: "WO-a", title: "A", dispatch: decided } }],
      { email: "a@test.com", role: "manager" },
      [],
      [{ user_id: "mgr-a", role: "manager" }],
    );
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t", {
        method: "POST",
        body: { row: { id: "WO-a", title: "A", dispatch: PROPOSAL } },
      }),
    );
    expect((await parseJsonResponse(res)).status).toBe(200);
    const persisted = upserts[0]!.row_data as { dispatch?: { status: string } };
    expect(persisted.dispatch?.status).toBe("approved");
  });
});
