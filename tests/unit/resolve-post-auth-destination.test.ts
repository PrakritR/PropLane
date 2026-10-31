import { describe, expect, it, vi } from "vitest";
import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";

/**
 * PRP-223: server returned /auth/connect-google-services but the client
 * resolver retried 16× because isValidPostAuthDestination rejected it.
 */
describe("resolvePostAuthDestination allowlist", () => {
  it("exports manager google services onboarding path for oauth continue", () => {
    expect(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH).toBe("/auth/connect-google-services");
  });

  it("classifies server unavailability without returning a portal destination", async () => {
    const mod = await import("@/lib/auth/resolve-post-auth-destination");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await mod.resolvePostAuthDestination("/portal/dashboard", "token")).toEqual({ redirectTo: null, resolutionFailed: true, serverUnavailable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("accepts connect-google-services as a post-auth destination (via module contract)", async () => {
    const mod = await import("@/lib/auth/resolve-post-auth-destination");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ redirectTo: MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redirectTo, resolutionFailed } = await mod.resolvePostAuthDestination("/portal/dashboard", "token");
    expect(resolutionFailed).toBe(false);
    expect(redirectTo).toBe(MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH);

    vi.unstubAllGlobals();
  });

  it.each(["/auth/manager/plan", "/auth/manager/choose-plan", "/auth/manager/connect-google"])(
    "accepts the slash-form manager plan route %s on the first attempt",
    async (path) => {
      const mod = await import("@/lib/auth/resolve-post-auth-destination");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ redirectTo: path }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { redirectTo, resolutionFailed } = await mod.resolvePostAuthDestination("/portal/dashboard", "token");
      expect(resolutionFailed).toBe(false);
      expect(redirectTo).toBe(path);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    },
  );
});

describe("resolveClientPostAuthDestination roles come only from profile_roles", () => {
  function fakeSupabase(email: string, roleRows: { role: string }[], profileRole: string | null) {
    return {
      auth: { getUser: async () => ({ data: { user: { id: "user-1", email } } }) },
      from: (table: string) => {
        const result =
          table === "profile_roles"
            ? { data: roleRows, error: null }
            : { data: profileRole ? { role: profileRole } : null, error: null };
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => (table === "profile_roles" ? Promise.resolve(result) : chain);
        chain.maybeSingle = async () => result;
        return chain;
      },
    } as never;
  }

  it("ignores the legacy profiles.role when profile_roles is empty", async () => {
    const mod = await import("@/lib/auth/resolve-post-auth-destination");
    const dest = await mod.resolveClientPostAuthDestination(fakeSupabase("someone@example.com", [], "manager"), "");
    expect(dest).toBe("/auth/get-started");
    expect(dest).not.toBe("/portal/dashboard");
  });

  it("routes a zero-role primary-admin email to get-started, never the admin portal", async () => {
    const mod = await import("@/lib/auth/resolve-post-auth-destination");
    const { PRIMARY_ADMIN_EMAIL } = await import("@/lib/auth/primary-admin");
    const dest = await mod.resolveClientPostAuthDestination(fakeSupabase(PRIMARY_ADMIN_EMAIL, [], null), "");
    expect(dest).toBe("/auth/get-started");
    expect(dest).not.toBe("/admin/dashboard");
  });

  it("still routes a stored manager role to the manager portal", async () => {
    const mod = await import("@/lib/auth/resolve-post-auth-destination");
    const dest = await mod.resolveClientPostAuthDestination(fakeSupabase("m@example.com", [{ role: "manager" }], null), "");
    expect(dest).toBe("/portal/dashboard");
  });
});
