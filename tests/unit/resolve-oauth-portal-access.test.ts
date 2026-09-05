import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

const ensureFreeManagerPortalAccess = vi.fn();
const completeResidentSignupFromOAuth = vi.fn();

vi.mock("@/lib/auth/manager-portal-provision", () => ({
  ensureFreeManagerPortalAccess: (...args: unknown[]) => ensureFreeManagerPortalAccess(...args),
}));

vi.mock("@/lib/auth/complete-resident-signup-oauth", () => ({
  completeResidentSignupFromOAuth: (...args: unknown[]) => completeResidentSignupFromOAuth(...args),
}));

vi.mock("@/lib/auth/manager-onboarding", () => ({
  managerNeedsPricingSelection: vi.fn(async () => false),
  findManagerPurchaseForAccount: vi.fn(async () => null),
  isManagerOnboardingComplete: vi.fn(() => false),
}));

vi.mock("@/lib/auth/primary-admin", () => ({
  isPrimaryAdminEmail: vi.fn(() => false),
}));

vi.mock("@/lib/auth/profile-role-row", () => ({
  ensureProfileRoleRow: vi.fn(async () => undefined),
}));

function mockSupabase(applicationRows: { id: string; resident_email: string; row_data: object }[] = []) {
  return {
    from: (table: string) => {
      if (table === "profile_roles") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }
      if (table === "manager_purchases") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
              is: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "manager_application_records") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: applicationRows, error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("resolveOAuthPortalRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never auto-provisions a free manager; manager intent goes to the chooser carrying its role", async () => {
    // AXI-126: they clicked "Property" at signup, so the chooser is handed the
    // role and provisions it exactly as a manual pick would — which for a manager
    // means the PLAN chooser, not a tier. No free portal is granted here.
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "new@test.com" } as User;
    const path = await resolveOAuthPortalRedirect(mockSupabase() as never, user, "/auth/continue", {
      intent: "manager",
      surface: "native",
    });

    expect(ensureFreeManagerPortalAccess).not.toHaveBeenCalled();
    expect(path).toBe("/auth/get-started?role=manager");
  });

  it("routes an unknown, no-intent account to the get-started role chooser", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "mystery@test.com" } as User;
    const path = await resolveOAuthPortalRedirect(mockSupabase() as never, user, "/auth/continue");

    expect(ensureFreeManagerPortalAccess).not.toHaveBeenCalled();
    expect(path).toBe("/auth/get-started");
  });

  it("routes a new manager with pending setup to Google services onboarding before the portal", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "manager@test.com" } as User;
    const supabase = {
      from: (table: string) => {
        if (table === "profile_roles") {
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { role: "manager" }, error: null }),
              }),
            }),
          };
        }
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "manager_application_records") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        if (table === "manager_automation_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: {
                      row_data: { googleServicesOnboarding: { pendingAt: "2026-01-01T00:00:00.000Z" } },
                    },
                    error: null,
                  }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const path = await resolveOAuthPortalRedirect(supabase as never, user, "/auth/continue");
    expect(path).toBe("/auth/connect-google-services");
  });

  it("routes a legacy manager without pending setup straight to the portal", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "manager@test.com" } as User;
    const supabase = {
      from: (table: string) => {
        if (table === "profile_roles") {
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { role: "manager" }, error: null }),
              }),
            }),
          };
        }
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "manager_application_records") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        if (table === "manager_automation_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const path = await resolveOAuthPortalRedirect(supabase as never, user, "/auth/continue");
    expect(path).toBe("/portal/dashboard");
  });

  it("AXI-152: a resident-intent prospect is never asked which portal they want", async () => {
    // They clicked "Apply" or a tour link, which carries role=resident. The OAuth
    // round trip preserves that as the intent, so the chooser is handed the role
    // and provisions instead of re-asking on the far side of a Google redirect.
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "prospect@test.com" } as User;
    const path = await resolveOAuthPortalRedirect(mockSupabase() as never, user, "/auth/continue", {
      intent: "resident",
    });

    expect(path).toBe("/auth/get-started?role=resident");
  });

  it("AXI-152: keeps where the prospect was going through the chooser", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "prospect@test.com" } as User;
    const path = await resolveOAuthPortalRedirect(
      mockSupabase() as never,
      user,
      "/resident/applications/apply",
      { intent: "resident" },
    );

    expect(path).toContain("role=resident");
    expect(path).toContain("next=%2Fresident%2Fapplications%2Fapply");
  });

  it("AXI-126: vendor intent is carried through too", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "vendor@test.com" } as User;
    const path = await resolveOAuthPortalRedirect(mockSupabase() as never, user, "/auth/continue", {
      intent: "vendor",
    });

    expect(path).toBe("/auth/get-started?role=vendor");
  });

  it("no intent still means the plain chooser — nothing is assumed", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");

    const user = { id: "user-1", email: "mystery2@test.com" } as User;
    expect(await resolveOAuthPortalRedirect(mockSupabase() as never, user, "/auth/continue")).toBe(
      "/auth/get-started",
    );
  });

  it("routes failed approved resident signup to create-account with error", async () => {
    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    completeResidentSignupFromOAuth.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This email already has a different login.",
    });

    const user = { id: "user-1", email: "resident@example.com" } as User;
    const supabase = mockSupabase([
      {
        id: "APP-1",
        resident_email: "resident@example.com",
        row_data: { bucket: "approved" },
      },
    ]);

    const path = await resolveOAuthPortalRedirect(supabase as never, user, "/portal/dashboard");

    expect(path).toContain("/auth/create-account");
    expect(path).toContain("message=resident_signup_failed");
    expect(path).toContain("error=This+email+already+has+a+different+login.");
  });

  it("routes primary admin with manager intent to the manager portal (not admin)", async () => {
    const { isPrimaryAdminEmail } = await import("@/lib/auth/primary-admin");
    const { ensureProfileRoleRow } = await import("@/lib/auth/profile-role-row");
    vi.mocked(isPrimaryAdminEmail).mockReturnValue(true);

    const { resolveOAuthPortalRedirect } = await import("@/lib/auth/resolve-oauth-portal-access");
    const user = { id: "founder", email: "prakritramachandran@gmail.com" } as User;
    const supabase = {
      from: (table: string) => {
        if (table === "profile_roles") {
          return { select: () => ({ eq: () => Promise.resolve({ data: [{ role: "admin" }], error: null }) }) };
        }
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: { role: "admin" }, error: null }),
              }),
            }),
          };
        }
        if (table === "manager_purchases") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                is: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "manager_application_records") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: [], error: null }),
            }),
          };
        }
        if (table === "manager_automation_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const path = await resolveOAuthPortalRedirect(supabase as never, user, "/auth/continue", {
      intent: "manager",
    });

    expect(ensureProfileRoleRow).toHaveBeenCalledWith(supabase, "founder", "manager");
    expect(path === "/portal/dashboard" || path === "/auth/connect-google-services").toBe(true);
  });
});
