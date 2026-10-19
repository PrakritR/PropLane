/**
 * /api/admin/service-workspaces: the admin gate runs on EVERY verb, and Open sets the workspace cookie only
 * for a member of a real service workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN_A = "22222222-2222-4222-8222-222222222222";
const ADMIN_B = "33333333-3333-4333-8333-333333333333";
const MANAGER = "44444444-4444-4444-8444-444444444444";

let db: ServiceFakeDb;
let signedIn: string | null = null;
let admins = new Set<string>();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: signedIn } : null } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => admins.has(id) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  listAdminUserIds: async () => [...admins],
}));
vi.mock("@/lib/manager-access-server", () => ({
  ensureProfileProplaneId: async (_db: unknown, id: string) => ({ ok: true, proplaneId: `AX-${id.slice(0, 4)}`, fullName: "N", email: "e@x.com", role: "admin" }),
}));

const route = await import("@/app/api/admin/service-workspaces/route");

const post = (body: unknown) =>
  route.POST(new Request("https://prop-lane.space/api/admin/service-workspaces", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  admins = new Set([OWNER, ADMIN_A, ADMIN_B]);
  signedIn = ADMIN_A;
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profile_roles: [{ user_id: OWNER, role: "manager" }],
    profiles: [OWNER, ADMIN_A, ADMIN_B, MANAGER].map((id) => ({ id })),
    portal_workspaces: [],
    account_link_invites: [],
    manager_property_records: [],
    manager_sms_numbers: [],
  });
});

const ACTIONS: Array<Record<string, unknown>> = [
  { action: "create", name: "PropLane Seattle", city: "Seattle" },
  { action: "rename", id: "x", name: "n" },
  { action: "open", id: "x" },
  { action: "team", id: "x" },
  { action: "team-add", id: "x", userId: ADMIN_B },
  { action: "team-remove", id: "x", linkId: "y" },
  { action: "attach-candidates", query: "" },
  { action: "attach", workspaceId: "cccccccc-1111-4111-8111-cccccccccccc", city: "Seattle", label: "L" },
];

describe("the admin gate", () => {
  it("answers 401 signed out on every verb, before any write", async () => {
    signedIn = null;
    expect((await route.GET()).status).toBe(401);
    for (const body of ACTIONS) expect((await post(body)).status).toBe(401);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.tables.portal_workspaces).toHaveLength(0);
  });

  it("answers 403 to a signed-in non-admin on every verb, and creates nothing", async () => {
    signedIn = MANAGER;
    expect((await route.GET()).status).toBe(403);
    for (const body of ACTIONS) expect((await post(body)).status).toBe(403);
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.tables.portal_workspaces).toHaveLength(0);
    expect(db.tables.account_link_invites).toHaveLength(0);
  });

  it("rejects a non-object body and an unknown action", async () => {
    expect((await post("x")).status).toBe(400);
    expect((await post({ action: "drop-everything" })).status).toBe(400);
  });
});

describe("create and open", () => {
  it("+ creates a workspace owned by the service owner and seats the admin; Open then sets the workspace cookie", async () => {
    const created = await post({ action: "create", name: "PropLane Seattle", city: "Seattle" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(db.tables.portal_workspaces[0]).toMatchObject({ id, owner_user_id: OWNER, is_service: true });

    const opened = await post({ action: "open", id });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toContain(`proplane-workspace=${id}`);
    expect(((await opened.json()) as { href: string }).href).toBe("/portal/properties");
  });

  it("Open sets NO cookie for an admin who is not on the team, or for a workspace that is not a service one", async () => {
    const created = await post({ action: "create", name: "PropLane Seattle", city: null });
    const { id } = (await created.json()) as { id: string };
    signedIn = ADMIN_B;
    const refused = await post({ action: "open", id });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
    db.tables.portal_workspaces.push({ id: "66666666-6666-4666-8666-666666666666", owner_user_id: MANAGER, name: "Manager WS", is_default: true, is_service: false });
    const foreign = await post({ action: "open", id: "66666666-6666-4666-8666-666666666666" });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("set-cookie")).toBeNull();
  });

  it("the list route reports each workspace with the viewer's standing", async () => {
    await post({ action: "create", name: "PropLane Seattle", city: "Seattle" });
    const res = await route.GET();
    const json = (await res.json()) as { configured: boolean; workspaces: Array<{ name: string; viewerRole: string | null }> };
    expect(json.configured).toBe(true);
    expect(json.workspaces).toMatchObject([{ name: "PropLane Seattle", viewerRole: "admin" }]);
  });
});

describe("attach", () => {
  const CLIENT_WS = "cccccccc-1111-4111-8111-cccccccccccc";

  it("attaches a client's workspace without moving it, then Open works for the attaching admin", async () => {
    db.tables.portal_workspaces.push({ id: CLIENT_WS, owner_user_id: MANAGER, name: "Ambika Homes", is_default: true, is_service: false });
    db.tables.manager_property_records.push({ id: "h1", manager_user_id: MANAGER, workspace_id: CLIENT_WS });
    db.tables.audit_log = [];
    const attached = await post({ action: "attach", workspaceId: CLIENT_WS, city: "Seattle", label: "Ambika" });
    expect(attached.status).toBe(201);
    expect(db.tables.portal_workspaces[0]).toMatchObject({ owner_user_id: MANAGER, is_service: true, name: "Ambika" });
    expect(db.tables.manager_property_records).toEqual([{ id: "h1", manager_user_id: MANAGER, workspace_id: CLIENT_WS }]);
    const opened = await post({ action: "open", id: CLIENT_WS });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("set-cookie")).toContain(`proplane-workspace=${CLIENT_WS}`);
  });

  it("a signed-in non-admin attaches nothing", async () => {
    signedIn = MANAGER;
    db.tables.portal_workspaces.push({ id: CLIENT_WS, owner_user_id: MANAGER, name: "Mine", is_default: true, is_service: false });
    expect((await post({ action: "attach", workspaceId: CLIENT_WS, city: null, label: null })).status).toBe(403);
    expect(db.tables.portal_workspaces[0]!.is_service).toBe(false);
  });
});
