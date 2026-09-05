import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistManagerPricingOffer } from "@/lib/auth/manager-pricing-oauth-storage";

const fetchMock = vi.fn();
const waitForAuthUser = vi.fn();

vi.stubGlobal("fetch", fetchMock);

vi.mock("@/lib/auth/wait-for-auth-user", () => ({
  waitForAuthUser: (...args: unknown[]) => waitForAuthUser(...args),
}));

vi.mock("@/lib/auth/wait-for-oauth-user", () => ({
  waitForOAuthUser: (...args: unknown[]) => waitForAuthUser(...args),
}));

vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: vi.fn(() => ({})),
}));

describe("resumePartnerPricingOAuth", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    fetchMock.mockReset();
    waitForAuthUser.mockResolvedValue({ id: "user-1", email: "a@example.com" });
    persistManagerPricingOffer({ tier: "pro", billing: "monthly" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps pricing offer when returning embedded checkout client secret", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ action: "checkout", clientSecret: "cs_test_123" }),
    });

    const { resumePartnerPricingOAuth } = await import("@/lib/auth/resume-partner-pricing-oauth");
    const result = await resumePartnerPricingOAuth();

    expect(result).toEqual({ status: "checkout", clientSecret: "cs_test_123" });
    expect(storage.has("axis:manager-pricing-offer")).toBe(true);
  });
});
