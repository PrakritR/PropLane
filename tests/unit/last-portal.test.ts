import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: vi.fn(async () => null) }));
vi.mock("@/lib/auth/complete-resident-signup-oauth", () => ({ completeResidentSignupFromOAuth: vi.fn() }));
vi.mock("@/lib/auth/manager-onboarding", () => ({
  managerNeedsPricingSelection: vi.fn(async () => false),
  findManagerPurchaseForAccount: vi.fn(async () => null),
  isManagerOnboardingComplete: vi.fn(() => false),
}));
vi.mock("@/lib/auth/manager-google-services-onboarding.server", () => ({ resolveManagerPortalEntryPath: vi.fn(async () => "/portal/dashboard") }));
vi.mock("@/lib/property-owner/access.server", () => ({ ownerAccessStateFor: vi.fn(async () => ({ ownerOnly: false })) }));
vi.mock("@/lib/auth/primary-admin", () => ({ isPrimaryAdminEmail: vi.fn(() => false) }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/resident-portal-access", () => ({
  loadResidentPortalAccessState: vi.fn(async () => ({})),
  residentPortalHomePath: vi.fn(() => "/resident/dashboard"),
}));

import { LAST_PORTAL_COOKIE, lastPortalCookieOptions, parseLastPortal, pickLastPortal, portalRoleForPath } from "@/lib/auth/last-portal";
import { resolveOAuthPortalRedirect, finalizeOAuthPortalRedirect } from "@/lib/auth/resolve-oauth-portal-access";

function supabaseWithRoles(roles: string[]) {
  return {
    from: (table: string) => {
      if (table === "profile_roles") return { select: () => ({ eq: () => Promise.resolve({ data: roles.map((role) => ({ role })), error: null }) }) };
      if (table === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: roles[0] ?? null }, error: null }) }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}
const user = { id: "u1", email: "person@example.test" } as User;

describe("last-portal cookie helpers", () => {
  it("stores a role string only and parses nothing else", () => {
    expect(LAST_PORTAL_COOKIE).toBe("pl_last_portal");
    expect(parseLastPortal("resident")).toBe("resident");
    for (const bad of ["", " ", "owner", "Resident", "manager,admin", "{\"role\":\"admin\"}", null, undefined]) expect(parseLastPortal(bad)).toBeNull();
  });

  it("is httpOnly, lax, site-wide and a year long", () => {
    expect(lastPortalCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 31_536_000, secure: true });
  });

  it("only honours a remembered role the account still holds", () => {
    expect(pickLastPortal(["manager", "resident"], "resident")).toBe("resident");
    expect(pickLastPortal(["manager", "resident"], "admin")).toBeNull();
    expect(pickLastPortal(["manager"], "bogus")).toBeNull();
    expect(pickLastPortal([], "manager")).toBeNull();
  });

  it.each([
    ["/portal/dashboard", "manager"], ["/pro", "manager"], ["/resident", "resident"], ["/resident/payments?x=1", "resident"],
    ["/vendor/dashboard", "vendor"], ["/admin", "admin"], ["/auth/choose-portal", null], ["/auth/get-started", null], ["/portalx", null],
  ])("maps %s to %s", (path, role) => expect(portalRoleForPath(path)).toBe(role));
});

describe("multi-role sign-in opens the portal used last", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the remembered portal, records it, and still shows the chooser with no memory", async () => {
    const trace: { roles?: string[]; openedLastPortal?: string | null } = {};
    const supabase = supabaseWithRoles(["manager", "resident"]);
    expect(await resolveOAuthPortalRedirect(supabase, user, "/auth/continue", { lastPortalRole: "resident", trace: trace as never })).toBe("/resident/dashboard");
    expect(trace).toMatchObject({ openedLastPortal: "resident", roles: ["manager", "resident"] });
    expect(await resolveOAuthPortalRedirect(supabase, user, "/auth/continue", { lastPortalRole: "manager" })).toBe("/portal/dashboard");
    expect(await resolveOAuthPortalRedirect(supabase, user, "/auth/continue")).toBe("/auth/choose-portal");
  });

  it("a remembered role the account no longer holds falls back to the chooser", async () => {
    const trace: { openedLastPortal?: string | null } = {};
    const path = await resolveOAuthPortalRedirect(supabaseWithRoles(["manager", "resident"]), user, "/auth/continue", { lastPortalRole: "admin", trace: trace as never });
    expect(path).toBe("/auth/choose-portal");
    expect(trace.openedLastPortal).toBeUndefined();
    expect(await finalizeOAuthPortalRedirect(supabaseWithRoles(["manager", "resident"]), user, "/auth/continue", { lastPortalRole: "vendor" })).toBe("/auth/choose-portal");
  });

  it("a ?next= deep link still wins over the remembered portal", async () => {
    const path = await resolveOAuthPortalRedirect(supabaseWithRoles(["manager", "resident"]), user, "/portal/properties", { lastPortalRole: "resident" });
    expect(path).toBe("/portal/properties");
  });

  it("a single-role account ignores the memory entirely", async () => {
    const trace: { openedLastPortal?: string | null } = {};
    expect(await resolveOAuthPortalRedirect(supabaseWithRoles(["resident"]), user, "/auth/continue", { lastPortalRole: "manager", trace: trace as never })).toBe("/resident/dashboard");
    expect(trace.openedLastPortal).toBeUndefined();
  });
});
