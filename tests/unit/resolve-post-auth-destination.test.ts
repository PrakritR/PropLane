import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";

describe("resolvePostAuthDestination", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("accepts /auth/connect-google-services from the server resolver", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ redirectTo: "/auth/connect-google-services" }),
    });

    const result = await resolvePostAuthDestination("/portal/dashboard", "token");

    expect(result).toEqual({
      redirectTo: "/auth/connect-google-services",
      resolutionFailed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
