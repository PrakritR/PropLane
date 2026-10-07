import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeSync = vi.fn<(uid: string) => Promise<void>>();
const appleSync = vi.fn<(uid: string) => Promise<void>>();
const disconnectLinks = vi.fn<(uid: string) => Promise<void>>();

vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseWithStripe: (uid: string) => stripeSync(uid),
}));
vi.mock("@/lib/manager-apple-subscription-sync", () => ({
  reconcileManagerPurchaseWithApple: (uid: string) => appleSync(uid),
}));
vi.mock("@/lib/co-manager-plan-reconcile.server", () => ({
  disconnectCoManagerLinksForPlanDowngrade: (uid: string) => disconnectLinks(uid),
}));
// No purchase row: revoke / expiry downgrade are no-ops, nothing is written.
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  }),
}));

import { invalidateManagerTierCache, syncManagerPurchaseTierState } from "@/lib/manager-tier-sync";

describe("manager tier sync cross-request cache", () => {
  beforeEach(() => {
    process.env.MANAGER_TIER_CACHE_IN_TEST = "1";
    invalidateManagerTierCache();
    stripeSync.mockReset().mockResolvedValue(undefined);
    appleSync.mockReset().mockResolvedValue(undefined);
    disconnectLinks.mockReset().mockResolvedValue(undefined);
  });

  it("caches a successful sync per user", async () => {
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u1");
    expect(stripeSync).toHaveBeenCalledTimes(1);
    await syncManagerPurchaseTierState("u2");
    expect(stripeSync).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent calls into one run", async () => {
    await Promise.all(Array.from({ length: 10 }, () => syncManagerPurchaseTierState("u1")));
    expect(stripeSync).toHaveBeenCalledTimes(1);
  });

  it("does not cache a run where a provider lookup failed", async () => {
    stripeSync.mockRejectedValueOnce(new Error("stripe down"));
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u1");
    expect(stripeSync).toHaveBeenCalledTimes(2);
    await syncManagerPurchaseTierState("u1");
    expect(stripeSync).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown sync", async () => {
    disconnectLinks.mockResolvedValue(undefined);
    appleSync.mockRejectedValueOnce(new Error("revenuecat down"));
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u1");
    expect(appleSync).toHaveBeenCalledTimes(2);
  });

  it("invalidate (one user or all) and fresh force a new run", async () => {
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u2");
    invalidateManagerTierCache("u1");
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u2");
    expect(stripeSync).toHaveBeenCalledTimes(3);
    invalidateManagerTierCache();
    await syncManagerPurchaseTierState("u2");
    expect(stripeSync).toHaveBeenCalledTimes(4);
    await syncManagerPurchaseTierState("u2", { fresh: true });
    expect(stripeSync).toHaveBeenCalledTimes(5);
  });

  it("an in-flight run started before an invalidation does not repopulate the cache", async () => {
    let release!: () => void;
    stripeSync.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = syncManagerPurchaseTierState("u1");
    await vi.waitFor(() => expect(stripeSync).toHaveBeenCalledTimes(1));
    invalidateManagerTierCache("u1");
    release();
    await first;
    await syncManagerPurchaseTierState("u1");
    expect(stripeSync).toHaveBeenCalledTimes(2);
  });

  it("is bypassed under NODE_ENV=test unless explicitly enabled", async () => {
    delete process.env.MANAGER_TIER_CACHE_IN_TEST;
    await syncManagerPurchaseTierState("u1");
    await syncManagerPurchaseTierState("u1");
    expect(stripeSync).toHaveBeenCalledTimes(2);
  });
});
