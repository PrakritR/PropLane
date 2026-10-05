import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purchases = vi.hoisted(() => ({
  configure: vi.fn(),
  logIn: vi.fn(),
  logOut: vi.fn(),
  restorePurchases: vi.fn(),
}));

vi.mock("@/lib/native/push-client", () => ({
  getNativeInfo: vi.fn(async () => ({ isNative: true, platform: "ios" })),
}));
vi.mock("@revenuecat/purchases-capacitor", () => ({ Purchases: purchases }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_REVENUECAT_IOS_API_KEY", "public-test-key");
  purchases.configure.mockResolvedValue(undefined);
  purchases.logIn.mockResolvedValue(undefined);
  purchases.logOut.mockResolvedValue(undefined);
  purchases.restorePurchases.mockResolvedValue({ customerInfo: { entitlements: { active: { pro: {} } } } });
});
afterEach(() => vi.unstubAllEnvs());

describe("RevenueCat restore identity", () => {
  it("configures a cold client for the requested manager before restoring", async () => {
    const { restoreManagerPurchases } = await import("@/lib/native/revenuecat-client");
    expect(await restoreManagerPurchases("manager-a", () => true)).toEqual({ ok: true, hasActiveEntitlement: true });
    expect(purchases.configure).toHaveBeenCalledWith({ apiKey: "public-test-key", appUserID: "manager-a" });
    expect(purchases.configure.mock.invocationCallOrder[0]).toBeLessThan(purchases.restorePurchases.mock.invocationCallOrder[0]);
  });

  it("does not restore without a user or successful configuration", async () => {
    const { restoreManagerPurchases } = await import("@/lib/native/revenuecat-client");
    expect(await restoreManagerPurchases(" ", () => true)).toEqual({ ok: false, hasActiveEntitlement: false });
    purchases.configure.mockRejectedValueOnce(new Error("configuration unavailable"));
    expect(await restoreManagerPurchases("manager-a", () => true)).toEqual({ ok: false, hasActiveEntitlement: false });
    expect(purchases.restorePurchases).not.toHaveBeenCalled();
  });

  it("serializes a pending account switch and restore under the requested identity", async () => {
    const { configureRevenueCat, restoreManagerPurchases } = await import("@/lib/native/revenuecat-client");
    expect(await configureRevenueCat("manager-a")).toBe(true);
    let releaseLogin!: () => void;
    purchases.logIn.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseLogin = resolve; }));
    const switching = configureRevenueCat("manager-b");
    const restoring = restoreManagerPurchases("manager-a", () => true);
    await vi.waitFor(() => expect(purchases.logIn).toHaveBeenCalledWith({ appUserID: "manager-b" }));
    expect(purchases.restorePurchases).not.toHaveBeenCalled();
    releaseLogin();
    expect(await switching).toBe(true);
    expect(await restoring).toEqual({ ok: true, hasActiveEntitlement: true });
    expect(purchases.logIn).toHaveBeenLastCalledWith({ appUserID: "manager-a" });
    expect(purchases.logIn.mock.invocationCallOrder[1]).toBeLessThan(purchases.restorePurchases.mock.invocationCallOrder[0]);
  });

  it("drops a queued restore when its manager signs out before provider work begins", async () => {
    const { configureRevenueCat, restoreManagerPurchases } = await import("@/lib/native/revenuecat-client");
    expect(await configureRevenueCat("manager-a")).toBe(true);
    let releaseLogin!: () => void;
    purchases.logIn.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseLogin = resolve; }));
    const switching = configureRevenueCat("manager-b");
    let currentUser = "manager-a";
    const restoring = restoreManagerPurchases("manager-a", () => currentUser === "manager-a");
    await vi.waitFor(() => expect(purchases.logIn).toHaveBeenCalledWith({ appUserID: "manager-b" }));
    currentUser = "manager-b";
    releaseLogin();
    expect(await switching).toBe(true);
    expect(await restoring).toEqual({ ok: false, hasActiveEntitlement: false });
    expect(purchases.logIn).toHaveBeenCalledTimes(1);
    expect(purchases.restorePurchases).not.toHaveBeenCalled();
  });
});
