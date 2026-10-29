/**
 * Expiring payment-waiver codes (captain, Oct 28). A waiver grant is void - the account resolves to Free, the
 * stored row is never rewritten - when the code's policy has expired or the row's own `promo_ends_at` has
 * passed. An unreadable policy never knocks an existing grant to Free, and always refuses a NEW redemption.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./support/memory-supabase";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: async () => true }));

import {
  isWaiverGrantEnded,
  isWaiverOnlyGrant,
  promoGrantEndedMessage,
  PROMO_CODE_EXPIRED_MESSAGE,
} from "@/lib/promo-code-expiry";
import {
  accountPromoEnded,
  checkPromoCodeRedeemable,
  clearPromoCodePolicyCache,
  readPromoCodePolicies,
  waiverGrantEndedFor,
} from "@/lib/promo-code-policy.server";
import { getEffectiveManagerSkuTier, getManagerPurchaseSku } from "@/lib/manager-access-server";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const PAST = "2026-10-01T00:00:00Z";
const FUTURE = "2099-01-01T00:00:00Z";
const USER = "00000000-0000-4000-8000-0000000000aa";

type Rows = Record<string, Record<string, unknown>[]>;

/** A memory db whose policy table answers like `policy` says: rows, a hard failure, or a missing relation. */
function dbWith(rows: Rows, policy: "ok" | "error" | "missing" = "ok"): MemoryDb {
  const base = createMemoryDb(rows);
  if (policy === "ok") return base;
  const original = base.from.bind(base);
  base.from = ((table: string) => {
    if (table !== "manager_promo_code_policies") return original(table);
    const error = policy === "missing" ? { code: "42P01", message: "relation does not exist" } : { code: "XX000", message: "boom" };
    const builder: Record<string, unknown> = {
      select: () => builder,
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error }),
    };
    return builder as never;
  }) as MemoryDb["from"];
  return base;
}

function purchase(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    user_id: USER,
    email: "m@example.com",
    tier: "pro",
    billing: "monthly",
    promo_code: "FREE100",
    promo_ends_at: null,
    stripe_subscription_id: null,
    stripe_checkout_session_id: `axis_waiver_pro_${USER}`,
    stripe_customer_id: null,
    apple_original_transaction_id: null,
    paid_at: PAST,
    ...over,
  };
}

function managerDb(purchaseRow: Record<string, unknown>, policies: Record<string, unknown>[] = [], policy: "ok" | "error" | "missing" = "ok") {
  return dbWith(
    {
      profiles: [{ id: USER, email: "m@example.com" }],
      manager_purchases: [purchaseRow],
      manager_promo_code_policies: policies,
    },
    policy,
  );
}

beforeEach(() => {
  clearPromoCodePolicyCache();
  state.db = null;
});

describe("the pure rules", () => {
  it("a passed policy or a passed row end voids a waiver grant; a future or missing one does not", () => {
    expect(isWaiverGrantEnded({ policyExpiresAt: PAST, nowMs: NOW })).toBe(true);
    expect(isWaiverGrantEnded({ promoEndsAt: PAST, nowMs: NOW })).toBe(true);
    expect(isWaiverGrantEnded({ policyExpiresAt: new Date(NOW).toISOString(), nowMs: NOW })).toBe(true);
    expect(isWaiverGrantEnded({ policyExpiresAt: FUTURE, promoEndsAt: FUTURE, nowMs: NOW })).toBe(false);
    expect(isWaiverGrantEnded({ policyExpiresAt: null, promoEndsAt: null, nowMs: NOW })).toBe(false);
    expect(isWaiverGrantEnded({ policyExpiresAt: "garbage", nowMs: NOW })).toBe(false);
  });

  it("only a waiver-ONLY grant can end: Stripe, Apple, admin and trial rows are paid or comped by something else", () => {
    const waiver = { promoCode: "FREE100", billing: "monthly", stripeCheckoutSessionId: "axis_waiver_pro_x" };
    expect(isWaiverOnlyGrant(waiver)).toBe(true);
    expect(isWaiverOnlyGrant({ ...waiver, stripeSubscriptionId: "sub_1" })).toBe(false);
    expect(isWaiverOnlyGrant({ ...waiver, billing: "apple", appleOriginalTransactionId: "tx1" })).toBe(false);
    expect(isWaiverOnlyGrant({ ...waiver, billing: "admin" })).toBe(false);
    expect(isWaiverOnlyGrant({ ...waiver, stripeCheckoutSessionId: "admin_portal_pro_x" })).toBe(false);
    expect(isWaiverOnlyGrant({ ...waiver, billing: "trial" })).toBe(false);
    expect(isWaiverOnlyGrant({ ...waiver, promoCode: "" })).toBe(false);
  });

  it("names the code in the line the manager sees", () => {
    expect(promoGrantEndedMessage("free100")).toBe("Your FREE100 access ended. Choose a plan to keep going.");
  });
});

describe("the policy read", () => {
  it("reads codes keyed without punctuation or case", async () => {
    const db = dbWith({ manager_promo_code_policies: [{ code: "free-100", expires_at: PAST }] });
    const read = await readPromoCodePolicies(db as never);
    expect(read.ok && read.expiresAtByCode.get("FREE100")).toBe(PAST);
  });

  it("an unreadable table is ok:false; a missing relation (code ahead of the migration) is no policies", async () => {
    expect(await readPromoCodePolicies(dbWith({}, "error") as never)).toEqual({ ok: false });
    const missing = await readPromoCodePolicies(dbWith({}, "missing") as never);
    expect(missing.ok && missing.expiresAtByCode.size).toBe(0);
  });

  it("redemption: an expired code is refused, a future or unset one is allowed", async () => {
    const expired = dbWith({ manager_promo_code_policies: [{ code: "FREE100", expires_at: PAST }] });
    expect(await checkPromoCodeRedeemable("free100", { db: expired as never, nowMs: NOW })).toEqual({ ok: false, reason: "expired" });
    const future = dbWith({ manager_promo_code_policies: [{ code: "FREE100", expires_at: FUTURE }] });
    expect(await checkPromoCodeRedeemable("FREE100", { db: future as never, nowMs: NOW })).toEqual({ ok: true });
    expect(await checkPromoCodeRedeemable("FREE100", { db: dbWith({}) as never, nowMs: NOW })).toEqual({ ok: true });
  });

  it("redemption fails CLOSED when the policy table cannot be read", async () => {
    expect(await checkPromoCodeRedeemable("FREE100", { db: dbWith({}, "error") as never, nowMs: NOW })).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("an existing grant fails SAFE: an unreadable policy or column leaves it valid", async () => {
    expect(await waiverGrantEndedFor({ promoCode: "FREE100", db: dbWith({}, "error") as never, nowMs: NOW })).toBe(false);
    const policyPast = dbWith({ manager_promo_code_policies: [{ code: "FREE100", expires_at: PAST }] });
    expect(await waiverGrantEndedFor({ promoCode: "FREE100", db: policyPast as never, nowMs: NOW })).toBe(true);
    const rowPast = dbWith({ manager_purchases: [purchase({ promo_ends_at: PAST })] });
    expect(await waiverGrantEndedFor({ promoCode: "FREE100", rowId: "p1", db: rowPast as never, nowMs: NOW })).toBe(true);
    const rowFuture = dbWith({ manager_purchases: [purchase({ promo_ends_at: FUTURE })] });
    expect(await waiverGrantEndedFor({ promoCode: "FREE100", rowId: "p1", db: rowFuture as never, nowMs: NOW })).toBe(false);
  });

  it("an account whose promo staff ended cannot redeem again", async () => {
    const ended = dbWith({ manager_purchases: [purchase({ promo_ends_at: PAST })] });
    expect(await accountPromoEnded(ended as never, USER, NOW)).toBe(true);
    const live = dbWith({ manager_purchases: [purchase({ promo_ends_at: FUTURE })] });
    expect(await accountPromoEnded(live as never, USER, NOW)).toBe(false);
  });

  it("an unreadable purchase read: existing-grant callers fail safe, a NEW redemption fails closed", async () => {
    const failing = {
      from: () => {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: "XX000", message: "boom" } }),
        };
        return builder;
      },
    };
    const throwing = { from: () => { throw new Error("down"); } };
    expect(await accountPromoEnded(failing as never, USER, NOW)).toBe(false);
    expect(await accountPromoEnded(failing as never, USER, NOW, { failClosed: true })).toBe(true);
    expect(await accountPromoEnded(throwing as never, USER, NOW)).toBe(false);
    expect(await accountPromoEnded(throwing as never, USER, NOW, { failClosed: true })).toBe(true);
    // A readable answer is unaffected by the flag.
    const live = dbWith({ manager_purchases: [purchase({ promo_ends_at: FUTURE })] });
    expect(await accountPromoEnded(live as never, USER, NOW, { failClosed: true })).toBe(false);
  });
});

describe("the plan the product enforces", () => {
  it("an active FREE100 grant is Pro", async () => {
    state.db = managerDb(purchase());
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "pro", billablePlan: false });
  });

  it("an expired code drops its grant to Free without rewriting the row", async () => {
    const db = managerDb(purchase(), [{ code: "FREE100", expires_at: PAST }]);
    state.db = db;
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "free" });
    const sku = await getManagerPurchaseSku(USER);
    expect(sku.waiverEndedCode).toBe("FREE100");
    expect(db.__tables.manager_purchases![0]).toMatchObject({ tier: "pro", billing: "monthly", promo_code: "FREE100" });
  });

  it("a future expiry keeps Pro until it arrives", async () => {
    state.db = managerDb(purchase(), [{ code: "FREE100", expires_at: FUTURE }]);
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "pro" });
  });

  it("ending the promo on one account drops only that account", async () => {
    state.db = managerDb(purchase({ promo_ends_at: PAST }));
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "free" });
  });

  it("an unreadable policy table leaves an existing grant valid (never a Free knock-down on a blip)", async () => {
    state.db = managerDb(purchase(), [], "error");
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "pro" });
  });

  it("an expired code never touches a Stripe-paid account that happens to record the code", async () => {
    state.db = managerDb(
      purchase({ stripe_subscription_id: "sub_1", billing: "monthly", stripe_checkout_session_id: "cs_1" }),
      [{ code: "FREE100", expires_at: PAST }],
    );
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "pro", billablePlan: true });
  });

  it("an expired code never touches an admin comp", async () => {
    state.db = managerDb(
      purchase({ billing: "admin", stripe_checkout_session_id: `admin_portal_pro_${USER}` }),
      [{ code: "FREE100", expires_at: PAST }],
    );
    expect(await getEffectiveManagerSkuTier(USER)).toMatchObject({ ok: true, tier: "pro", billablePlan: false });
  });
});

describe("copy", () => {
  it("refuses with the one expiry sentence", () => {
    expect(PROMO_CODE_EXPIRED_MESSAGE).toBe("This code has expired.");
  });
});
