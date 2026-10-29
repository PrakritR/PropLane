/**
 * Staff can expire a promo code so the manager has to pay (captain, Oct 28). Admin-only, a required reason, the
 * audit row first (a failed audit write changes nothing), and the policy / Stripe write only after it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { createMemoryDb, type MemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  audit: vi.fn(),
  waivers: vi.fn(),
  stripe: {
    promotionCodes: { retrieve: vi.fn(), update: vi.fn() },
    subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  },
  db: null as unknown as MemoryDb,
}));

vi.mock("@/lib/admin/admin-route-guard.server", () => ({ requireAdminRoute: mocks.gate }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => mocks.stripe }));
vi.mock("@/lib/admin-billing-audit.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-billing-audit.server")>("@/lib/admin-billing-audit.server");
  return { ...actual, writeAdminBillingAudit: mocks.audit };
});
vi.mock("@/lib/admin/admin-promo-codes.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/admin-promo-codes.server")>("@/lib/admin/admin-promo-codes.server");
  return { ...actual, loadWaiverPurchases: mocks.waivers };
});
vi.mock("@/lib/test-workspaces/effects.server", () => ({ assertTestWorkspaceProviderEffectAllowed: vi.fn(async () => {}) }));
vi.mock("@/lib/manager-tier-sync-cache", () => ({ invalidateManagerTierCache: vi.fn() }));

import { PATCH } from "@/app/api/admin/promo-codes/route";
import { POST as endPromo } from "@/app/api/admin/accounts/[id]/billing/end-promo/route";
import { clearPromoCodePolicyCache } from "@/lib/promo-code-policy.server";

const ADMIN = "00000000-0000-4000-8000-0000000000ad";
const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const patch = (body: unknown) =>
  new Request("http://test/api/admin/promo-codes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const endReq = (body: unknown) =>
  new Request("http://test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id = ACCOUNT) => ({ params: Promise.resolve({ id }) });

/** A calendar date `days` from now, as the YYYY-MM-DD the dialog sends. */
const dateKeyIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const waiverRows = [
  { user_id: "u1", email: "a@x.com", promo_code: "FREE100", billing: "monthly", stripe_checkout_session_id: "axis_waiver_pro_u1", paid_at: null },
  { user_id: "u2", email: "b@x.com", promo_code: "FREE100", billing: "annual", stripe_checkout_session_id: "axis_waiver_pro_u2", paid_at: null },
  { user_id: "u3", email: "c@x.com", promo_code: "FREE100", billing: "admin", stripe_checkout_session_id: "admin_portal_pro_u3", paid_at: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearPromoCodePolicyCache();
  mocks.db = createMemoryDb({ manager_promo_code_policies: [], manager_purchases: [], audit_log: [] });
  mocks.gate.mockResolvedValue({ ok: true, userId: ADMIN });
  mocks.audit.mockResolvedValue({ ok: true, recorded: 1 });
  mocks.waivers.mockResolvedValue(waiverRows);
});

describe("PATCH /api/admin/promo-codes expire", () => {
  it("is admin-only: 401 and 403 reach the caller and nothing is written", async () => {
    mocks.gate.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) });
    const res = await PATCH(patch({ verb: "expire", code: "FREE100", expiresAt: "now", reason: "ending comps" }));
    expect(res.status).toBe(403);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.db.__tables.manager_promo_code_policies).toHaveLength(0);
  });

  it("refuses without a reason, before any audit or write", async () => {
    for (const reason of [undefined, "", "   "]) {
      const res = await PATCH(patch({ verb: "expire", code: "FREE100", expiresAt: "now", reason }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("A reason is required.");
    }
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.db.__tables.manager_promo_code_policies).toHaveLength(0);
  });

  it("expires a waiver code: audit first, then one policy row, counting the accounts that drop to Free", async () => {
    const order: string[] = [];
    mocks.audit.mockImplementation(async () => {
      order.push(`audit:policies=${mocks.db.__tables.manager_promo_code_policies!.length}`);
      return { ok: true, recorded: 1 };
    });
    const res = await PATCH(patch({ verb: "expire", code: "free100", expiresAt: "now", reason: "Ending the launch comp" }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["audit:policies=0"]);
    const body = await res.json();
    expect(body.expired).toMatchObject({ kind: "waiver", code: "FREE100", accounts: 2, auditRecorded: true });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ADMIN, reason: "Ending the launch comp", entries: [expect.objectContaining({ field: "promoCodeExpiry:FREE100" })] }),
    );
    const [policy] = mocks.db.__tables.manager_promo_code_policies!;
    expect(policy).toMatchObject({ code: "FREE100", reason: "Ending the launch comp", updated_by: ADMIN });
    expect(Date.parse(String(policy!.expires_at))).toBeLessThanOrEqual(Date.now());
  });

  it("a failed audit write refuses the whole action: no policy row", async () => {
    mocks.audit.mockResolvedValue({ ok: false, recorded: 0 });
    const res = await PATCH(patch({ verb: "expire", code: "FREE100", expiresAt: "now", reason: "x" }));
    expect(res.status).toBe(500);
    expect(mocks.db.__tables.manager_promo_code_policies).toHaveLength(0);
  });

  it("a future date schedules the end at the close of that Pacific day; a past date is refused", async () => {
    const ok = await PATCH(patch({ verb: "expire", code: "FREE100", expiresAt: dateKeyIn(30), reason: "scheduled" }));
    expect(ok.status).toBe(200);
    const endsAt = Date.parse(String(mocks.db.__tables.manager_promo_code_policies![0]!.expires_at));
    expect(endsAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(endsAt).toBeLessThan(Date.now() + 32 * 86_400_000);
    const past = await PATCH(patch({ verb: "expire", code: "FREE100", expiresAt: "2020-01-01", reason: "late" }));
    expect(past.status).toBe(400);
  });

  it("refuses a code that is not a payment-waiver code", async () => {
    mocks.waivers.mockResolvedValue([]);
    const res = await PATCH(patch({ verb: "expire", code: "NOTACODE", expiresAt: "now", reason: "x" }));
    expect(res.status).toBe(404);
    expect(mocks.db.__tables.manager_promo_code_policies).toHaveLength(0);
  });

  it("a Stripe code is turned off, and with endStripeDiscounts the discount comes off each subscriber", async () => {
    mocks.stripe.promotionCodes.retrieve.mockResolvedValue({ id: "promo_ABC123", code: "FIRST20", active: true, metadata: {}, times_redeemed: 1 });
    mocks.stripe.promotionCodes.update.mockResolvedValue({});
    mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      status: "active",
      discounts: [
        { id: "di_1", promotion_code: "promo_ABC123" },
        { id: "di_2", promotion_code: "promo_OTHER1" },
      ],
    });
    mocks.stripe.subscriptions.update.mockResolvedValue({});
    mocks.db.__tables.manager_purchases!.push({ user_id: "u9", stripe_subscription_id: "sub_9", stripe_promotion_code: "FIRST20" });

    const res = await PATCH(
      patch({ verb: "expire", code: "FIRST20", id: "promo_ABC123", expiresAt: "now", reason: "promo over", endStripeDiscounts: true }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).expired).toMatchObject({ kind: "stripe", discountsEnded: 1, discountsFailed: 0 });
    expect(mocks.stripe.promotionCodes.update).toHaveBeenCalledWith("promo_ABC123", expect.objectContaining({ active: false }));
    expect(mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      "sub_9",
      { discounts: [{ discount: "di_2" }] },
      { idempotencyKey: "expire-promo:promo_ABC123:sub_9" },
    );
  });

  it("a Stripe code leaves existing discounts alone unless asked", async () => {
    mocks.stripe.promotionCodes.retrieve.mockResolvedValue({ id: "promo_ABC123", code: "FIRST20", active: true, metadata: {}, times_redeemed: 1 });
    mocks.stripe.promotionCodes.update.mockResolvedValue({});
    const res = await PATCH(patch({ verb: "expire", code: "FIRST20", id: "promo_ABC123", expiresAt: "now", reason: "promo over" }));
    expect(res.status).toBe(200);
    expect(mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/accounts/[id]/billing/end-promo", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    user_id: ACCOUNT,
    tier: "pro",
    billing: "monthly",
    promo_code: "FREE100",
    promo_ends_at: null,
    stripe_subscription_id: null,
    stripe_checkout_session_id: `axis_waiver_pro_${ACCOUNT}`,
    apple_original_transaction_id: null,
    ...over,
  });

  it("is admin-only", async () => {
    mocks.gate.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) });
    const res = await endPromo(endReq({ endsAt: "now", reason: "x" }), ctx());
    expect(res.status).toBe(401);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("requires a reason and a real account id", async () => {
    mocks.db.__tables.manager_purchases!.push(row());
    expect((await endPromo(endReq({ endsAt: "now" }), ctx())).status).toBe(400);
    expect((await endPromo(endReq({ endsAt: "now", reason: "x" }), ctx("not-a-uuid"))).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.db.__tables.manager_purchases![0]!.promo_ends_at).toBeNull();
  });

  it("sets promo_ends_at after the audit row, and reports the access ended", async () => {
    mocks.db.__tables.manager_purchases!.push(row());
    const res = await endPromo(endReq({ endsAt: "now", reason: "Chargeback risk" }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, auditRecorded: true, accessEnded: true, appliesTo: "waiver_grant" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: ACCOUNT, entries: [expect.objectContaining({ field: "promoEndsAt" })] }),
    );
    expect(Date.parse(String(mocks.db.__tables.manager_purchases![0]!.promo_ends_at))).toBeLessThanOrEqual(Date.now());
  });

  it("a failed audit write changes nothing", async () => {
    mocks.db.__tables.manager_purchases!.push(row());
    mocks.audit.mockResolvedValue({ ok: false, recorded: 0 });
    const res = await endPromo(endReq({ endsAt: "now", reason: "x" }), ctx());
    expect(res.status).toBe(500);
    expect(mocks.db.__tables.manager_purchases![0]!.promo_ends_at).toBeNull();
  });

  it("a future date is recorded without ending anything yet", async () => {
    mocks.db.__tables.manager_purchases!.push(row());
    const res = await endPromo(endReq({ endsAt: dateKeyIn(30), reason: "scheduled" }), ctx());
    expect(await res.json()).toMatchObject({ ok: true, accessEnded: false, appliesTo: "waiver_grant" });
  });

  it("an account with no promo code has nothing to end", async () => {
    mocks.db.__tables.manager_purchases!.push(row({ promo_code: null }));
    const res = await endPromo(endReq({ endsAt: "now", reason: "x" }), ctx());
    expect(res.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("a Stripe-paid account's end date is recorded but changes no access", async () => {
    mocks.db.__tables.manager_purchases!.push(row({ stripe_subscription_id: "sub_1", stripe_checkout_session_id: "cs_1" }));
    const res = await endPromo(endReq({ endsAt: "now", reason: "x" }), ctx());
    expect(await res.json()).toMatchObject({ ok: true, accessEnded: false, appliesTo: "recorded_only" });
  });
});
