/**
 * `/api/auth/provision-pending-manager` allows admin accounts to add the
 * manager portal (same as residents). Production entry to `/portal` for
 * non-primary admins stays gated by `adminBlockedFromManagerPortal`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

let currentUser: { id: string; email: string } = { id: "user-1", email: "ops@prop-lane.space" };
let roleRows: { role: string }[] = [];
let legacyRole: string | null = null;

const ensureFreeManagerPortalAccess = vi.fn(async () => ({ status: "portal_ready", managerId: "mgr-1", provisioned: true }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser } }),
      getSession: async () => ({ data: { session: null } }),
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: table === "profile_roles" ? roleRows : null, error: null }).then(resolve);
        },
        maybeSingle: async () => ({ data: table === "profiles" ? { role: legacyRole } : null, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/auth/manager-portal-provision", () => ({
  ensureFreeManagerPortalAccess: (...args: unknown[]) => ensureFreeManagerPortalAccess(...(args as [])),
}));
vi.mock("@/lib/google-calendar/link-after-manager-provision.server", () => ({
  finalizeManagerGoogleCalendarLink: async () => ({ connected: false }),
}));
vi.mock("@/lib/auth/manager-google-services-onboarding.server", () => ({
  resolveManagerPortalEntryPath: async () => "/portal/dashboard",
}));
vi.mock("@/lib/app-url", () => ({ resolveRequestOrigin: () => "http://localhost:3000" }));

async function post() {
  const { POST } = await import("@/app/api/auth/provision-pending-manager/route");
  const res = await POST(new Request("http://localhost/api/auth/provision-pending-manager", { method: "POST", body: "{}" }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: "user-1", email: "ops@prop-lane.space" };
  roleRows = [];
  legacyRole = null;
});

describe("POST /api/auth/provision-pending-manager — admin accounts", () => {
  it("provisions an account holding the admin role row", async () => {
    roleRows = [{ role: "admin" }];
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, managerId: "mgr-1" });
    expect(ensureFreeManagerPortalAccess).toHaveBeenCalledTimes(1);
  });

  it("provisions a legacy profiles.role = admin account with no role rows", async () => {
    legacyRole = "admin";
    const res = await post();
    expect(res.status).toBe(200);
    expect(ensureFreeManagerPortalAccess).toHaveBeenCalledTimes(1);
  });

  it("still provisions a resident-only account that asked for the property portal", async () => {
    roleRows = [{ role: "resident" }];
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, managerId: "mgr-1" });
    expect(ensureFreeManagerPortalAccess).toHaveBeenCalledTimes(1);
  });

  it("still provisions the primary admin", async () => {
    currentUser = { id: "founder", email: PRIMARY_ADMIN_EMAIL };
    roleRows = [{ role: "admin" }];
    const res = await post();
    expect(res.status).toBe(200);
    expect(ensureFreeManagerPortalAccess).toHaveBeenCalledTimes(1);
  });
});
