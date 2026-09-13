/**
 * Regression: subscription-route-still-collapses-unreadable-plan-to-free.
 *
 * The server gate (`assertManagerPropertyListingQuota`) already refuses to read
 * an unreadable plan as Free — it answers 500. This route is the OTHER half:
 * it feeds the client pre-checks, which cache what it says. A failed
 * `manager_purchases` read arrives as `tier: null`, and `tier: null` resolves
 * to Free, so the route used to hand back `effectiveTier: "free"` and
 * `propertyLimit: 1`. A Business manager with five listings then got the red
 * "You've reached your plan limit of 1 property" banner and a "+ Add property"
 * that refused before any request was made — while the route that pre-check was
 * previewing would have answered 500 rather than a Free refusal.
 *
 * An unknown plan means the client stops pre-judging. Nothing is waved through:
 * the server gate is still the limit, and it fails closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_MAX_PROPERTIES, FREE_MAX_PROPERTIES } from "@/lib/manager-access";

const getUser = vi.fn();

let SKU: {
  tier: string | null;
  billing: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  appleOriginalTransactionId: string | null;
  readFailed: boolean;
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/manager-tier-sync", () => ({ syncManagerPurchaseTierState: async () => {} }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("Stripe is not configured in this test");
  },
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: async () => SKU,
}));

import { GET } from "@/app/api/manager/subscription/route";

type SubscriptionBody = {
  tier: string | null;
  effectiveTier: string | null;
  planUnknown: boolean;
  propertyLimit: number | null;
  accountLinkLimit: number | null;
  isFree: boolean;
};

async function get(): Promise<SubscriptionBody> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as SubscriptionBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  SKU = {
    tier: null,
    billing: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    appleOriginalTransactionId: null,
    readFailed: false,
  };
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
});

describe("a plan the server could not read", () => {
  it("is reported as unknown, never as Free", async () => {
    SKU = { ...SKU, readFailed: true };

    const body = await get();

    expect(body.planUnknown).toBe(true);
    expect(body.effectiveTier).toBeNull();
    expect(body.isFree).toBe(false);
  });

  it("hands back no property or account-link limit for the client to enforce", async () => {
    SKU = { ...SKU, readFailed: true };

    const body = await get();

    // `null` is what stops pro-properties.tsx drawing the limit banner and
    // pre-refusing "+ Add property"; the server gate still decides the write.
    expect(body.propertyLimit).toBeNull();
    expect(body.accountLinkLimit).toBeNull();
    expect(body.propertyLimit).not.toBe(FREE_MAX_PROPERTIES);
  });

  it("does not invent a plan for a paying account whose read failed", async () => {
    SKU = { ...SKU, tier: "business", readFailed: true };

    const body = await get();

    expect(body.planUnknown).toBe(true);
    expect(body.propertyLimit).toBeNull();
    expect(body.propertyLimit).not.toBe(BUSINESS_MAX_PROPERTIES);
  });
});

describe("a plan the server DID read", () => {
  it("still resolves an account that never chose a plan to Free — the fix this branch exists for", async () => {
    const body = await get();

    expect(body.planUnknown).toBe(false);
    expect(body.tier).toBeNull();
    expect(body.effectiveTier).toBe("free");
    expect(body.propertyLimit).toBe(FREE_MAX_PROPERTIES);
    expect(body.isFree).toBe(true);
  });

  it("reports a committed plan and its own larger cap", async () => {
    SKU = { ...SKU, tier: "business", billing: "monthly" };

    const body = await get();

    expect(body.effectiveTier).toBe("business");
    expect(body.propertyLimit).toBe(BUSINESS_MAX_PROPERTIES);
    expect(body.isFree).toBe(false);
  });

  it("leaves an unrecognized tier backed by a live subscription uncapped", async () => {
    SKU = { ...SKU, tier: null, stripeSubscriptionId: "sub_live", billing: "monthly" };

    const body = await get();

    expect(body.planUnknown).toBe(false);
    expect(body.effectiveTier).toBeNull();
    expect(body.propertyLimit).toBeNull();
  });
});
