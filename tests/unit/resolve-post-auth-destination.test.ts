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
