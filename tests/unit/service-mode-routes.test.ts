/**
 * Service mode at the routes: GET /api/workspaces leaves a staff service workspace out of the Property portal's
 * list (the rail payload only), and a plain switch to the manager portal drops a cookie that still names one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "22222222-2222-4222-8222-222222222222";
const AMBIKA = "a0000000-0000-4000-8000-00000000000a";
const MINE = "c0000000-0000-4000-8000-00000000000c";

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  workspaces: [] as Array<Record<string, unknown>>,
  staff: new Set<string>(),
  staffFailed: false,
  propertyWorkspace: null as string | null,
  roles: ["admin", "manager"] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "proplane-workspace" && state.cookie ? { value: state.cookie } : undefined) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: async () => state.workspaces,
  loadWorkspacePlan: async () => ({ tier: "pro", unknown: false, workspaceLimit: 1, usage: { workspaces: 1 } }),
}));
vi.mock("@/lib/service/service-mode.server", () => ({
  loadServiceStaffIds: async () => ({ ids: state.staff, failed: state.staffFailed }),
  loadPropertyPortalWorkspaceId: async () => state.propertyWorkspace,
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/auth/portal-access", () => ({
  ACTIVE_PORTAL_COOKIE: "axis_active_portal",
  getPortalAccessContext: async () => ({ user: { id: USER }, roles: state.roles, effectiveRole: "manager" }),
  isPortalRoleReachable: (ctx: { roles: string[] }, role: string) => ctx.roles.includes(role),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  LEGACY_PREVIEW_UID_COOKIE_NAME: "legacy",
  PREVIEW_PORTAL_COOKIE: "pp",
  PREVIEW_UID_COOKIE: "pu",
}));

const workspacesRoute = await import("@/app/api/workspaces/route");
const portalRoute = await import("@/app/api/auth/set-active-portal/route");

const ws = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  ownerUserId: USER,
  owned: true,
  isDefault: false,
  propertyIds: [],
  propertyPermissions: {},
  ...over,
});

beforeEach(() => {
  state.cookie = undefined;
  state.staff = new Set();
  state.staffFailed = false;
  state.propertyWorkspace = null;
  state.roles = ["admin", "manager"];
  state.workspaces = [ws(MINE, "My homes", { isDefault: true }), ws(AMBIKA, "Ambika", { isService: true, owned: false })];
});

describe("GET /api/workspaces", () => {
  const get = async () => (await workspacesRoute.GET()).json() as Promise<{ workspaces: { id: string }[]; activeWorkspaceId: string | null }>;

  it("an admin's Property portal lists only their own workspaces", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = MINE;
    const body = await get();
    expect(body.workspaces.map((w) => w.id)).toEqual([MINE]);
    expect(body.activeWorkspaceId).toBe(MINE);
  });

  it("a cookie naming the service workspace is service mode: the full list, that workspace active", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = AMBIKA;
    const body = await get();
    expect(body.workspaces.map((w) => w.id)).toEqual([MINE, AMBIKA]);
    expect(body.activeWorkspaceId).toBe(AMBIKA);
  });

  it("an ordinary manager and a client owner (not staff) see exactly what they saw before", async () => {
    state.workspaces = [ws(MINE, "My homes"), ws(AMBIKA, "Ambika", { isService: true, readOnly: true })];
    state.cookie = AMBIKA;
    const body = await get();
    expect(body.workspaces.map((w) => w.id)).toEqual([MINE, AMBIKA]);
    expect(body.activeWorkspaceId).toBe(AMBIKA);
  });

  it("a staff read that failed fails closed: a service workspace the viewer does not own is left out", async () => {
    state.staffFailed = true;
    state.cookie = AMBIKA;
    const body = await get();
    expect(body.workspaces.map((w) => w.id)).toEqual([MINE]);
    expect(body.activeWorkspaceId).toBe(MINE);
  });

  it("...and the client owner's OWN managed workspace still stays (view-only, not hidden)", async () => {
    state.staffFailed = true;
    state.workspaces = [ws(AMBIKA, "Ambika", { isService: true, owned: true, readOnly: true })];
    state.cookie = AMBIKA;
    const body = await get();
    expect(body.workspaces.map((w) => w.id)).toEqual([AMBIKA]);
  });
});

describe("POST /api/auth/set-active-portal: the workspace cookie hazard", () => {
  const post = (body: Record<string, unknown>) =>
    portalRoute.POST(new Request("https://prop-lane.space/api/auth/set-active-portal", { method: "POST", body: JSON.stringify(body) }));
  const workspaceCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("proplane-workspace="));

  it("a plain switch to the manager portal points a service cookie at the account's own workspace", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = AMBIKA;
    state.propertyWorkspace = MINE;
    const res = await post({ role: "manager" });
    expect(res.status).toBe(200);
    expect(workspaceCookie(res)).toContain(`proplane-workspace=${MINE}`);
  });

  it("with no workspace of its own the service cookie is cleared", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = AMBIKA;
    const res = await post({ role: "manager" });
    expect(workspaceCookie(res)).toMatch(/proplane-workspace=;/);
  });

  it("opening a service workspace keeps the cookie it just set", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = AMBIKA;
    expect(workspaceCookie(await post({ role: "manager", keepWorkspace: true }))).toBeUndefined();
  });

  it("a staff read that failed drops the selection too (it cannot be proved not to be a service workspace)", async () => {
    state.staffFailed = true;
    state.cookie = AMBIKA;
    state.propertyWorkspace = MINE;
    expect(workspaceCookie(await post({ role: "manager" }))).toContain(`proplane-workspace=${MINE}`);
  });

  it("an ordinary cookie, or the admin role, is left alone", async () => {
    state.staff = new Set([AMBIKA]);
    state.cookie = MINE;
    expect(workspaceCookie(await post({ role: "manager" }))).toBeUndefined();
    state.cookie = AMBIKA;
    expect(workspaceCookie(await post({ role: "admin" }))).toBeUndefined();
  });
});
