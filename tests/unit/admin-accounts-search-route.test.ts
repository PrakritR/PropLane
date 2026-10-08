/**
 * GET /api/admin/accounts/search: the Accounts list's one server-side search.
 *
 * It matches name, email, phone or PropLane ID, keeps the three tab counts describing the SAME query,
 * hides sandbox accounts, and never lists a resident or vendor under Managers just because every
 * account carries a PropLane ID.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminFakeDb, type AdminFakeDb, type Row } from "../helpers/admin-fake-db";

const isAdminUser = vi.fn();
const getUser = vi.fn();
const serviceRoleFactory = vi.fn();

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceRoleFactory() }));

const { GET } = await import("@/app/api/admin/accounts/search/route");

const seed = (): Record<string, Row[]> => ({
  profile_roles: [
    { user_id: "m1", role: "manager" },
    { user_id: "m2", role: "manager" },
    { user_id: "mSandbox", role: "manager" },
    { user_id: "r1", role: "resident" },
    { user_id: "v1", role: "vendor" },
  ],
  profiles: [
    { id: "m1", email: "ada@acme.com", full_name: "Ada Lovelace", phone: "+1 (206) 555-0142", manager_id: "AXIS-1001", application_approved: true, created_at: "2026-09-01T00:00:00Z" },
    { id: "m2", email: "grace@navy.mil", full_name: "Grace Hopper", phone: "", manager_id: "AXIS-1002", application_approved: false, created_at: "2026-09-02T00:00:00Z" },
    { id: "mSandbox", email: "demo@axis.local", full_name: "Demo Manager", manager_id: "AXIS-9999", created_at: "2026-09-03T00:00:00Z" },
    // Residents and vendors carry a PropLane ID too.
    { id: "r1", email: "ada.resident@home.com", full_name: "Adam Resident", manager_id: "AXIS-2001", created_at: "2026-09-04T00:00:00Z" },
    { id: "v1", email: "pipes@plumb.com", full_name: "Pat Plumber", manager_id: "AXIS-3001", created_at: "2026-09-05T00:00:00Z" },
  ],
  manager_purchases: [],
  portal_workspaces: [
    { id: "w1", owner_user_id: "m1" },
    { id: "w2", owner_user_id: "m1" },
  ],
});

let db: AdminFakeDb;
const search = (qs: string) => GET(new Request(`https://prop-lane.space/api/admin/accounts/search?${qs}`));
const asAdmin = () => {
  getUser.mockResolvedValue({ data: { user: { id: "admin-1" } } });
  isAdminUser.mockResolvedValue(true);
};

beforeEach(() => {
  isAdminUser.mockReset();
  getUser.mockReset();
  serviceRoleFactory.mockReset();
  db = createAdminFakeDb(seed(), { m1: { last_sign_in_at: "2026-10-04T12:00:00Z" } });
  serviceRoleFactory.mockImplementation(() => db);
});

describe("GET /api/admin/accounts/search", () => {
  it("is 401 signed out and 403 for a non-admin, before reading anything", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await search("kind=manager")).status).toBe(401);
    getUser.mockResolvedValue({ data: { user: { id: "x" } } });
    isAdminUser.mockResolvedValue(false);
    expect((await search("kind=manager")).status).toBe(403);
    expect(serviceRoleFactory).not.toHaveBeenCalled();
  });

  it("lists managers with workspaces, last sign-in and status, never a sandbox account or a resident", async () => {
    asAdmin();
    const body = await (await search("kind=manager&q=")).json();
    expect(body.rows.map((r: { id: string }) => r.id).sort()).toEqual(["m1", "m2"]);
    const ada = body.rows.find((r: { id: string }) => r.id === "m1");
    expect(ada).toMatchObject({ kind: "manager", workspaceCount: 2, lastSignInAt: "2026-10-04T12:00:00Z", active: true, managerId: "AXIS-1001" });
    const grace = body.rows.find((r: { id: string }) => r.id === "m2");
    expect(grace).toMatchObject({ active: false, lastSignInAt: null });
    expect(body.counts).toEqual({ manager: 2, resident: 1, vendor: 1 });
  });

  it("matches name, email, phone digits and PropLane ID, and counts every tab for the same query", async () => {
    asAdmin();
    const byName = await (await search("kind=manager&q=lovelace")).json();
    expect(byName.rows.map((r: { id: string }) => r.id)).toEqual(["m1"]);

    const byEmail = await (await search("kind=manager&q=NAVY.MIL")).json();
    expect(byEmail.rows.map((r: { id: string }) => r.id)).toEqual(["m2"]);

    const byPhone = await (await search("kind=manager&q=206%20555")).json();
    expect(byPhone.rows.map((r: { id: string }) => r.id)).toEqual(["m1"]);

    const byId = await (await search("kind=manager&q=axis-1002")).json();
    expect(byId.rows.map((r: { id: string }) => r.id)).toEqual(["m2"]);

    // "ada" is Ada (manager) and Adam's email "ada.resident" (resident): the tab counts both.
    const shared = await (await search("kind=resident&q=ada")).json();
    expect(shared.counts).toEqual({ manager: 1, resident: 1, vendor: 0 });
    expect(shared.rows.map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("matches a term holding a comma or parentheses (PostgREST reserves both)", async () => {
    asAdmin();
    const base = seed();
    db = createAdminFakeDb(
      {
        ...base,
        profiles: [
          ...base.profiles!,
          { id: "m4", email: "jane@doe.com", full_name: "Doe, Jane", manager_id: "AXIS-1004", application_approved: true, created_at: "2026-09-06T00:00:00Z" },
          { id: "m5", email: "old@smith.com", full_name: "Smith (old)", manager_id: "AXIS-1005", application_approved: true, created_at: "2026-09-07T00:00:00Z" },
        ],
      },
      { m1: { last_sign_in_at: "2026-10-04T12:00:00Z" } },
    );
    serviceRoleFactory.mockImplementation(() => db);

    const comma = await (await search(`kind=manager&q=${encodeURIComponent("Doe, Jane")}`)).json();
    expect(comma.rows.map((r: { id: string }) => r.id)).toEqual(["m4"]);
    expect(comma.counts).toEqual({ manager: 1, resident: 0, vendor: 0 });

    const parens = await (await search(`kind=manager&q=${encodeURIComponent("Smith (old)")}`)).json();
    expect(parens.rows.map((r: { id: string }) => r.id)).toEqual(["m5"]);
  });

  it("totals every tab count, and says so, whatever the page scan found", async () => {
    asAdmin();
    const body = await (await search("kind=manager&q=")).json();
    expect(body.countsComplete).toBe(true);
    expect(body.counts).toEqual({ manager: 2, resident: 1, vendor: 1 });
  });

  it("returns residents and vendors without a workspace count", async () => {
    asAdmin();
    const residents = await (await search("kind=resident")).json();
    expect(residents.rows[0]).toMatchObject({ id: "r1", kind: "resident" });
    expect(residents.rows[0]).not.toHaveProperty("workspaceCount");
    const vendors = await (await search("kind=vendor")).json();
    expect(vendors.rows.map((r: { id: string }) => r.id)).toEqual(["v1"]);
  });
});
