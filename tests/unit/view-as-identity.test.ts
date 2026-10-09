import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signViewAsToken,
  VIEW_AS_TTL_SECONDS,
  type ViewAsPayload,
} from "@/lib/auth/view-as-token";
import { makeFakeDb, standardAuthUsers, standardTables, UUID } from "./view-as-fake-db";

const SECRET = "i".repeat(40);

const state = vi.hoisted(() => ({
  realUserId: "" as string,
  cookieValue: undefined as string | undefined,
  pathname: "/portal/dashboard" as string | null,
  db: null as unknown,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "axis_view_as" && state.cookieValue ? { value: state.cookieValue } : undefined),
    getAll: () => [],
    set: () => undefined,
  })),
  headers: vi.fn(async () => new Headers(state.pathname ? { "x-pathname": state.pathname } : {})),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async (jwt?: string) => ({
        data: { user: { id: state.realUserId, email: "ops@example.com", user_metadata: { role: "admin" }, app_metadata: {}, aud: "authenticated", created_at: "" } },
        error: null,
        jwt,
      })),
      getClaims: vi.fn(async () => ({
        data: { claims: { sub: state.realUserId, email: "ops@example.com", role: "authenticated" }, header: {}, signature: new Uint8Array() },
        error: null,
      })),
    },
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => state.db),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));

const { createSupabaseServerClient } = await import("@/lib/supabase/server");
const { resetViewAsResolutionCache } = await import("@/lib/auth/view-as.server");
const { getServerSessionProfile } = await import("@/lib/auth/server-profile");

function payload(overrides: Partial<ViewAsPayload> = {}): ViewAsPayload {
  const iat = Math.floor(Date.now() / 1000) - 10;
  return { v: 1, adminId: UUID.admin, targetId: UUID.manager, portal: "manager", iat, exp: iat + VIEW_AS_TTL_SECONDS, sid: "sid-id-1", ...overrides };
}

async function open(overrides: Partial<ViewAsPayload> = {}) {
  state.cookieValue = await signViewAsToken(payload(overrides), SECRET);
}

function seedDb(tables = standardTables()) {
  const fake = makeFakeDb({ tables, authUsers: standardAuthUsers() });
  state.db = fake.db;
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetViewAsResolutionCache();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  process.env.PROPLANE_VIEW_AS_SECRET = SECRET;
  process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = UUID.admin;
  state.realUserId = UUID.admin;
  state.cookieValue = undefined;
  state.pathname = "/portal/dashboard";
  seedDb();
});

async function actingId(): Promise<string | undefined> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id;
}

describe("server client identity while viewing as", () => {
  it("answers as the viewed account for a valid session", async () => {
    await open();
    expect(await actingId()).toBe(UUID.manager);
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getClaims();
    expect(data?.claims.sub).toBe(UUID.manager);
  });

  it("answers as the admin with no cookie", async () => {
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores a tampered cookie", async () => {
    await open();
    // Tamper the signed BODY, never the signature's last base64 character: that char
    // carries unused bits, so flipping it can decode to the same HMAC and still verify
    // (a ~3% flake). A changed body always changes the signed message.
    const [body, sig] = state.cookieValue!.split(".");
    state.cookieValue = `${body!.replace(/^./, (c) => (c === "a" ? "b" : "a"))}.${sig}`;
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores an expired session", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    await open({ iat: past, exp: past + VIEW_AS_TTL_SECONDS });
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores a cookie issued to a DIFFERENT admin (another operator's browser session)", async () => {
    await open({ adminId: UUID.admin2 });
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores the session once the operator leaves the allowlist", async () => {
    await open();
    process.env.PROPLANE_VIEW_AS_OPERATOR_IDS = UUID.admin2;
    expect(await actingId()).toBe(UUID.admin);
    delete process.env.PROPLANE_VIEW_AS_OPERATOR_IDS;
    resetViewAsResolutionCache();
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores the session once the operator stops being an admin", async () => {
    await open();
    const tables = standardTables();
    tables.profile_roles = tables.profile_roles!.filter((r) => r.user_id !== UUID.admin);
    tables.profiles = tables.profiles!.map((p) => (p.id === UUID.admin ? { ...p, role: "manager" } : p));
    seedDb(tables);
    expect(await actingId()).toBe(UUID.admin);
  });

  it("ignores the session if the viewed account lost the portal or became an admin", async () => {
    await open();
    const tables = standardTables();
    tables.profile_roles = tables.profile_roles!.filter((r) => r.user_id !== UUID.manager);
    tables.profiles = tables.profiles!.map((p) => (p.id === UUID.manager ? { ...p, role: "resident" } : p));
    seedDb(tables);
    expect(await actingId()).toBe(UUID.admin);

    resetViewAsResolutionCache();
    const tables2 = standardTables();
    tables2.profile_roles!.push({ user_id: UUID.manager, role: "admin" });
    seedDb(tables2);
    expect(await actingId()).toBe(UUID.admin);
  });

  it("fails closed with no secret", async () => {
    await open();
    delete process.env.PROPLANE_VIEW_AS_SECRET;
    expect(await actingId()).toBe(UUID.admin);
  });

  it("keeps the operator themselves on the admin console and auth routes", async () => {
    await open();
    for (const path of ["/admin/dashboard", "/api/admin/preview", "/api/auth/sign-out"]) {
      state.pathname = path;
      resetViewAsResolutionCache();
      expect(await actingId(), path).toBe(UUID.admin);
    }
    state.pathname = "/api/property-records";
    expect(await actingId()).toBe(UUID.manager);
  });

  it("works for the vendor and resident portals", async () => {
    await open({ targetId: UUID.vendor, portal: "vendor" });
    expect(await actingId()).toBe(UUID.vendor);
    resetViewAsResolutionCache();
    await open({ targetId: UUID.resident, portal: "resident" });
    expect(await actingId()).toBe(UUID.resident);
  });

  it("never substitutes an explicit-jwt lookup", async () => {
    await open();
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser("some.jwt.token");
    expect(data.user?.id).toBe(UUID.admin);
  });
});

describe("a representative GET route while viewing as", () => {
  const profiles = () => {
    const tables = standardTables();
    tables.profiles = tables.profiles!.map((p) =>
      p.id === UUID.manager ? { ...p, phone: "+12065550101" } : p.id === UUID.admin ? { ...p, phone: "+19995550000" } : p,
    );
    return tables;
  };

  it("returns the viewed account's rows while a session is open, and the operator's own otherwise", async () => {
    seedDb(profiles());
    const { GET } = await import("@/app/api/profile/route");

    const own = await (await GET()).json();
    expect(own).toMatchObject({ fullName: "Ops Admin", email: "ops@example.com", phone: "+19995550000" });

    await open();
    const viewed = await (await GET()).json();
    expect(viewed).toMatchObject({ fullName: "Mia Manager", email: "mgr@example.com", phone: "+12065550101" });
  });

  it("session profile resolves as the viewed account with the portal the operator opened", async () => {
    seedDb(profiles());
    await open();
    const session = await getServerSessionProfile();
    expect(session.user?.id).toBe(UUID.manager);
    expect(session.profile?.full_name).toBe("Mia Manager");
    expect(session.viewAs?.portal).toBe("manager");
    expect(session.viewAs?.adminId).toBe(UUID.admin);
  });
});
