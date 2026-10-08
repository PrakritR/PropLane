import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signViewAsToken,
  VIEW_AS_COOKIE,
  VIEW_AS_TTL_SECONDS,
  verifyViewAsToken,
  type ViewAsPayload,
} from "@/lib/auth/view-as-token";
import { makeFakeDb, standardAuthUsers, standardTables, UUID, type FakeDbOptions } from "./view-as-fake-db";

const SECRET = "r".repeat(40);

const state = vi.hoisted(() => ({
  realUser: { id: "" } as { id: string } | null,
  isAdmin: true,
  cookieValue: undefined as string | undefined,
  db: null as unknown,
  testClassification: { kind: "normal" } as { kind: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.realUser }, error: null })) },
  })),
  createSupabaseServerClient: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => state.db),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn(async () => state.isAdmin),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === VIEW_AS_COOKIE && state.cookieValue ? { value: state.cookieValue } : undefined),
  })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => state.testClassification),
  isTrustedTestWorkspaceOperatorId: vi.fn((id: string) => (process.env.PROPLANE_TEST_WORKSPACE_OPERATOR_IDS ?? "").split(",").includes(id)),
}));

const route = await import("@/app/api/admin/preview/route");

function seedDb(opts: FakeDbOptions = {}) {
  const fake = makeFakeDb({ tables: standardTables(), authUsers: standardAuthUsers(), ...opts });
  state.db = fake.db;
  return fake;
}

function post(body: unknown, headers: Record<string, string> = { origin: "https://proplane.ai", host: "proplane.ai" }) {
  return new Request("https://proplane.ai/api/admin/preview", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const valid = { targetUserId: UUID.manager, portal: "manager", reason: "Customer cannot see rent" };

function setCookieOf(res: Response, name = VIEW_AS_COOKIE): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PROPLANE_VIEW_AS_SECRET = SECRET;
  process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = UUID.admin;
  delete process.env.PROPLANE_TEST_WORKSPACE_OPERATOR_IDS;
  state.realUser = { id: UUID.admin };
  state.isAdmin = true;
  state.cookieValue = undefined;
  state.testClassification = { kind: "normal" };
  seedDb();
});

describe("POST /api/admin/preview (start)", () => {
  it("starts a session: audit row first, then ONE signed httpOnly cookie", async () => {
    const fake = seedDb();
    const res = await route.POST(post(valid));
    expect(res.status).toBe(200);
    expect((await res.json()).redirectTo).toBe("/portal/dashboard");

    expect(fake.audit).toHaveLength(1);
    const row = fake.audit[0]!;
    expect(row.action).toBe("admin_view_as_started");
    expect(row.actor_user_id).toBe(UUID.admin);
    expect(row.landlord_id).toBe(UUID.manager);
    expect(row.input_summary).toMatchObject({ portal: "manager", reason: "Customer cannot see rent", targetUserId: UUID.manager });
    expect(String(row.dedupe_key)).toMatch(/^view_as_started:/);

    const cookie = setCookieOf(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(new RegExp(`Max-Age=${VIEW_AS_TTL_SECONDS + 300}`));
    const value = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    const parsed = await verifyViewAsToken(value, SECRET);
    expect(parsed).toMatchObject({ adminId: UUID.admin, targetId: UUID.manager, portal: "manager" });
    expect(parsed!.exp - parsed!.iat).toBe(VIEW_AS_TTL_SECONDS);
    expect(row.input_summary).toMatchObject({ sid: parsed!.sid });
    // The unsigned cookies this feature used to set are gone.
    expect(setCookieOf(res, "axis_admin_preview_uid")).toBeUndefined();
    expect(setCookieOf(res, "axis_admin_preview_portal")).toBeUndefined();
  });

  it("closes the trail for an earlier session that timed out without an End", async () => {
    const tables = standardTables();
    const startedAt = new Date(Date.now() - 3 * 3600_000);
    tables.audit_log = [
      {
        actor_user_id: UUID.admin,
        landlord_id: UUID.resident,
        action: "admin_view_as_started",
        dedupe_key: "view_as_started:old-1",
        input_summary: {
          sid: "old-1",
          portal: "resident",
          startedAt: startedAt.toISOString(),
          expiresAt: new Date(startedAt.getTime() + VIEW_AS_TTL_SECONDS * 1000).toISOString(),
        },
      },
    ];
    const fake = seedDb({ tables });
    expect((await route.POST(post(valid))).status).toBe(200);
    const ended = fake.audit.find((r) => r.action === "admin_view_as_ended");
    expect(ended).toMatchObject({ actor_user_id: UUID.admin, landlord_id: UUID.resident, dedupe_key: "view_as_ended:old-1" });
    expect((ended!.input_summary as { how: string; durationSeconds: number })).toMatchObject({ how: "expired", durationSeconds: VIEW_AS_TTL_SECONDS });
    expect(fake.audit.filter((r) => r.action === "admin_view_as_started")).toHaveLength(1);
  });

  it("works for resident and vendor portals", async () => {
    for (const [targetUserId, portal, to] of [
      [UUID.resident, "resident", "/resident"],
      [UUID.vendor, "vendor", "/vendor/dashboard"],
    ] as const) {
      const res = await route.POST(post({ targetUserId, portal, reason: "Support ticket 123" }));
      expect(res.status).toBe(200);
      expect((await res.json()).redirectTo).toBe(to);
    }
  });

  it("refuses a non-admin", async () => {
    state.isAdmin = false;
    const fake = seedDb();
    const res = await route.POST(post(valid));
    expect(res.status).toBe(403);
    expect(setCookieOf(res)).toBeUndefined();
    expect(fake.audit).toHaveLength(0);
  });

  it("refuses an admin who is not on the operator allowlist", async () => {
    state.realUser = { id: UUID.admin2 };
    const res = await route.POST(post(valid));
    expect(res.status).toBe(403);
    expect(setCookieOf(res)).toBeUndefined();
  });

  it("fails closed when the allowlist is empty or unset", async () => {
    delete process.env.PROPLANE_VIEW_AS_OPERATOR_IDS;
    expect((await route.POST(post(valid))).status).toBe(403);
    process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = "";
    expect((await route.POST(post(valid))).status).toBe(403);
  });

  it("fails closed when the signing secret is unset or too short", async () => {
    delete process.env.PROPLANE_VIEW_AS_SECRET;
    const fake = seedDb();
    const res = await route.POST(post(valid));
    expect(res.status).toBe(503);
    expect(setCookieOf(res)).toBeUndefined();
    expect(fake.audit).toHaveLength(0);
    process.env.PROPLANE_VIEW_AS_SECRET = "short";
    expect((await route.POST(post(valid))).status).toBe(503);
  });

  it("refuses when nobody is signed in", async () => {
    state.realUser = null;
    expect((await route.POST(post(valid))).status).toBe(403);
  });

  it("refuses a cross-origin or origin-less request", async () => {
    expect((await route.POST(post(valid, { origin: "https://evil.example", host: "proplane.ai" }))).status).toBe(403);
    expect((await route.POST(post(valid, { host: "proplane.ai" }))).status).toBe(403);
  });

  it("requires a reason of 3 to 300 characters", async () => {
    for (const reason of [undefined, "", "  ", "ab", "x".repeat(301), 5]) {
      const fake = seedDb();
      const res = await route.POST(post({ ...valid, reason }));
      expect(res.status, String(reason)).toBe(400);
      expect(setCookieOf(res)).toBeUndefined();
      expect(fake.audit).toHaveLength(0);
    }
    expect((await route.POST(post({ ...valid, reason: "abc" }))).status).toBe(200);
  });

  it("rejects a bad body, a bad portal and a non-uuid target", async () => {
    expect((await route.POST(post("not json"))).status).toBe(400);
    expect((await route.POST(post({ ...valid, portal: "admin" }))).status).toBe(400);
    expect((await route.POST(post({ ...valid, targetUserId: "mgr-1" }))).status).toBe(400);
    expect((await route.POST(post({ ...valid, targetUserId: undefined }))).status).toBe(400);
  });

  it("refuses a target that does not hold the requested portal (profile_roles, not profiles.role)", async () => {
    const fake = seedDb();
    const res = await route.POST(post({ ...valid, portal: "vendor" }));
    expect(res.status).toBe(400);
    expect(setCookieOf(res)).toBeUndefined();
    expect(fake.audit).toHaveLength(0);

    // A legacy profiles.role alone, with no profile_roles row, still counts (same rule as portal-access).
    const tables = standardTables();
    tables.profile_roles = tables.profile_roles!.filter((r) => r.user_id !== UUID.manager);
    seedDb({ tables });
    expect((await route.POST(post(valid))).status).toBe(200);
  });

  it("refuses an admin target and yourself", async () => {
    expect((await route.POST(post({ ...valid, targetUserId: UUID.admin2, portal: "manager" }))).status).toBe(400);
    expect((await route.POST(post({ ...valid, targetUserId: UUID.admin, portal: "manager" }))).status).toBe(400);
  });

  it("refuses a disabled or purged account", async () => {
    const tables = standardTables();
    tables.profiles = tables.profiles!.map((p) => (p.id === UUID.manager ? { ...p, application_approved: false } : p));
    seedDb({ tables });
    expect((await route.POST(post(valid))).status).toBe(400);

    const authUsers = standardAuthUsers();
    delete authUsers[UUID.resident];
    seedDb({ authUsers });
    expect((await route.POST(post({ targetUserId: UUID.resident, portal: "resident", reason: "Support ticket" }))).status).toBe(400);

    seedDb({ authUsers: { ...standardAuthUsers(), [UUID.vendor]: { banned_until: new Date(Date.now() + 86_400_000).toISOString() } } });
    expect((await route.POST(post({ targetUserId: UUID.vendor, portal: "vendor", reason: "Support ticket" }))).status).toBe(400);
  });

  it("refuses a test-workspace member unless the operator is a test-workspace operator", async () => {
    state.testClassification = { kind: "classified" };
    const body = { targetUserId: UUID.testMember, portal: "manager", reason: "Reproduce a bug" };
    expect((await route.POST(post(body))).status).toBe(400);
    process.env.PROPLANE_TEST_WORKSPACE_OPERATOR_IDS = UUID.admin;
    expect((await route.POST(post(body))).status).toBe(200);
  });

  it("fails closed when the audit insert fails: no cookie, no session", async () => {
    const fake = seedDb({ auditError: { message: "db down" } });
    const res = await route.POST(post(valid));
    expect(res.status).toBe(500);
    expect(setCookieOf(res)).toBeUndefined();
    expect(fake.audit).toHaveLength(0);
  });

  it("never notifies the viewed account: the only side effect is the audit row", async () => {
    const fake = seedDb();
    await route.POST(post(valid));
    const touched = fake.db.from.mock.calls.map((c) => c[0]);
    expect(fake.audit).toHaveLength(1);
    expect([...new Set(touched)].sort()).toEqual(["audit_log", "profile_roles", "profiles"]);
    expect(touched.some((t) => /notif|message|inbox|email|sms/i.test(String(t)))).toBe(false);
  });
});

describe("DELETE /api/admin/preview (end)", () => {
  async function liveCookie(overrides: Partial<ViewAsPayload> = {}) {
    const iat = Math.floor(Date.now() / 1000) - 60;
    const payload: ViewAsPayload = {
      v: 1,
      adminId: UUID.admin,
      targetId: UUID.manager,
      portal: "manager",
      iat,
      exp: iat + VIEW_AS_TTL_SECONDS,
      sid: "sid-end-1",
      ...overrides,
    };
    return { payload, token: await signViewAsToken(payload, SECRET) };
  }
  const del = () =>
    new Request("https://proplane.ai/api/admin/preview", {
      method: "DELETE",
      headers: { origin: "https://proplane.ai", host: "proplane.ai" },
    });

  it("writes the ended row (with duration) and clears the cookie", async () => {
    const fake = seedDb();
    state.cookieValue = (await liveCookie()).token;
    const res = await route.DELETE(del());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, audited: true });
    expect(setCookieOf(res)).toMatch(/Max-Age=0/);
    expect(fake.audit).toHaveLength(1);
    expect(fake.audit[0]).toMatchObject({ action: "admin_view_as_ended", actor_user_id: UUID.admin, landlord_id: UUID.manager });
    expect((fake.audit[0]!.input_summary as { durationSeconds: number }).durationSeconds).toBeGreaterThanOrEqual(60);
    expect((fake.audit[0]!.input_summary as { how: string }).how).toBe("ended");
  });

  it("is idempotent per session: a second End writes no second row", async () => {
    const fake = seedDb();
    state.cookieValue = (await liveCookie()).token;
    await route.DELETE(del());
    const again = await route.DELETE(del());
    expect(again.status).toBe(200);
    expect(fake.audit).toHaveLength(1);
  });

  it("closes an EXPIRED session as expired, capping the duration at the 30 minute window", async () => {
    const fake = seedDb();
    const past = Math.floor(Date.now() / 1000) - 3 * 3600;
    state.cookieValue = (await liveCookie({ iat: past, exp: past + VIEW_AS_TTL_SECONDS })).token;
    const res = await route.DELETE(del());
    expect(await res.json()).toMatchObject({ audited: true });
    const summary = fake.audit[0]!.input_summary as { how: string; durationSeconds: number };
    expect(summary.how).toBe("expired");
    expect(summary.durationSeconds).toBe(VIEW_AS_TTL_SECONDS);
  });

  it("clears the cookie even when the audit write fails, or the cookie is junk, or nobody is signed in", async () => {
    state.cookieValue = (await liveCookie()).token;
    seedDb({ auditError: { message: "db down" } });
    const failed = await route.DELETE(del());
    expect(failed.status).toBe(200);
    expect(setCookieOf(failed)).toMatch(/Max-Age=0/);

    state.cookieValue = "garbage";
    expect(setCookieOf(await route.DELETE(del()))).toMatch(/Max-Age=0/);

    state.realUser = null;
    state.cookieValue = (await liveCookie()).token;
    expect(setCookieOf(await route.DELETE(del()))).toMatch(/Max-Age=0/);
  });

  it("does not write an ended row for a cookie that belongs to a different operator", async () => {
    const fake = seedDb();
    state.realUser = { id: UUID.admin2 };
    state.cookieValue = (await liveCookie()).token;
    const res = await route.DELETE(del());
    expect(await res.json()).toMatchObject({ audited: false });
    expect(fake.audit).toHaveLength(0);
  });

  it("refuses a cross-origin End", async () => {
    const res = await route.DELETE(
      new Request("https://proplane.ai/api/admin/preview", { method: "DELETE", headers: { origin: "https://evil.example", host: "proplane.ai" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/preview (state for the admin UI)", () => {
  const get = (q = "") => new Request(`https://proplane.ai/api/admin/preview${q}`);

  it("tells an allowlisted admin which portals the target holds", async () => {
    const res = await route.GET(get(`?targetUserId=${UUID.manager}`));
    expect(await res.json()).toMatchObject({ canViewAs: true, portals: ["manager"], active: null });
  });

  it("shows nothing to a non-allowlisted admin, a non-admin or a signed-out caller", async () => {
    state.realUser = { id: UUID.admin2 };
    expect(await (await route.GET(get(`?targetUserId=${UUID.manager}`))).json()).toEqual({ canViewAs: false, portals: [], active: null });
    state.realUser = { id: UUID.admin };
    state.isAdmin = false;
    expect((await (await route.GET(get())).json()).canViewAs).toBe(false);
    state.realUser = null;
    expect((await (await route.GET(get())).json()).canViewAs).toBe(false);
  });

  it("offers no portals for an admin target", async () => {
    const res = await route.GET(get(`?targetUserId=${UUID.admin2}`));
    expect(await res.json()).toMatchObject({ canViewAs: true, portals: [] });
  });
});
