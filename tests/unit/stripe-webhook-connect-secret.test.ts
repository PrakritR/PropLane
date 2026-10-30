/**
 * Two Stripe endpoints post to one route: the platform endpoint (STRIPE_WEBHOOK_SECRET) and the Connect endpoint
 * (STRIPE_CONNECT_WEBHOOK_SECRET) that carries connected-account events. Each is signed with its own secret.
 */
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ accountUpdated: vi.fn(async () => undefined), payout: vi.fn(async () => undefined), paidRecord: vi.fn(async () => undefined), track: vi.fn(), expense: vi.fn() }));
const real = new Stripe("sk_test_unit", { apiVersion: "2025-01-27.acacia" as never });

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? sigHolder.value : null) }),
}));
const sigHolder = vi.hoisted(() => ({ value: "" }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => real }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: spies.track }));
vi.mock("@/lib/reports/auto-expense", () => ({ recordAutoExpense: spies.expense }));
vi.mock("@/lib/manager-purchase-from-session", async (orig) => ({ ...(await orig<typeof import("@/lib/manager-purchase-from-session")>()), resolveManagerCheckoutPurchase: async () => ({ userId: null }), recordPaidManagerCheckoutSession: spies.paidRecord }));
vi.mock("@/lib/stripe-webhook-financials", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe-webhook-financials")>()),
  handleStripeAccountUpdated: spies.accountUpdated,
  handleConnectPayoutEvent: spies.payout,
}));

import { POST as webhook } from "@/app/api/stripe/webhook/route";
import {
  isConnectedAccountEvent,
  stripeWebhookSecrets,
  verifyStripeWebhookEvent,
} from "@/lib/stripe/webhook-verify";

const PLATFORM = "whsec_platform_secret_value";
const CONNECT = "whsec_connect_secret_value";

function signed(event: Record<string, unknown>, secret: string): Request {
  const payload = JSON.stringify(event);
  sigHolder.value = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/stripe/webhook", { method: "POST", body: payload });
}

const accountUpdated = (account: string, objectId = account) => ({
  id: "evt_acct_1", object: "event", type: "account.updated", account,
  data: { object: { id: objectId, object: "account", metadata: {} } },
});

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", PLATFORM);
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT);
  spies.accountUpdated.mockClear();
  spies.payout.mockClear();
  spies.paidRecord.mockClear(); spies.track.mockClear(); spies.expense.mockClear();
});

describe("webhook secrets", () => {
  it("lists the platform secret then the Connect secret, skipping blanks and a duplicate", () => {
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: " a ", STRIPE_CONNECT_WEBHOOK_SECRET: "b" } as never)).toEqual([
      { source: "platform", secret: "a" }, { source: "connect", secret: "b" },
    ]);
    expect(stripeWebhookSecrets({ STRIPE_WEBHOOK_SECRET: "a", STRIPE_CONNECT_WEBHOOK_SECRET: "a" } as never)).toHaveLength(1);
    expect(stripeWebhookSecrets({ STRIPE_CONNECT_WEBHOOK_SECRET: "b" } as never)).toEqual([{ source: "connect", secret: "b" }]);
    expect(stripeWebhookSecrets({} as never)).toEqual([]);
  });

  it("verifies against each secret in turn and rejects when none match", () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "payout.paid" });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: CONNECT });
    const secrets = stripeWebhookSecrets();
    expect(verifyStripeWebhookEvent(real, payload, header, secrets)).toMatchObject({ ok: true, source: "connect" });
    const wrong = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else" });
    expect(verifyStripeWebhookEvent(real, payload, wrong, secrets)).toMatchObject({ ok: false });
    expect(verifyStripeWebhookEvent(real, payload, header, [])).toMatchObject({ ok: false });
  });

  it("calls an event a connected-account event only when it names an acct_ and is a handled type", () => {
    expect(isConnectedAccountEvent({ type: "account.updated", account: "acct_1" } as never)).toBe(true);
    expect(isConnectedAccountEvent({ type: "payout.paid", account: "acct_1" } as never)).toBe(true);
    expect(isConnectedAccountEvent({ type: "account.external_account.updated", account: "acct_1" } as never)).toBe(true);
    expect(isConnectedAccountEvent({ type: "account.updated" } as never)).toBe(false);
    expect(isConnectedAccountEvent({ type: "checkout.session.completed", account: "acct_1" } as never)).toBe(false);
    expect(isConnectedAccountEvent({ type: "account.updated", account: "cus_1" } as never)).toBe(false);
  });
});

describe("the webhook route with two endpoints", () => {
  it("applies a connected-account event signed with the Connect secret", async () => {
    const res = await webhook(signed(accountUpdated("acct_123"), CONNECT));
    expect(res.status).toBe(200);
    expect(spies.accountUpdated).toHaveBeenCalledTimes(1);
  });

  it("still applies an event signed with the platform secret", async () => {
    const res = await webhook(signed(accountUpdated("acct_123"), PLATFORM));
    expect(res.status).toBe(200);
    expect(spies.accountUpdated).toHaveBeenCalledTimes(1);
  });

  it("rejects an event signed with neither secret", async () => {
    const res = await webhook(signed(accountUpdated("acct_123"), "whsec_attacker"));
    expect(res.status).toBe(400);
    expect(spies.accountUpdated).not.toHaveBeenCalled();
  });

  it("acknowledges and ignores a platform-type event that only the Connect secret signed", async () => {
    const res = await webhook(signed({ id: "evt_x", object: "event", type: "checkout.session.completed", account: "acct_123", data: { object: { id: "cs_1", metadata: { purpose: "household_charge" } } } }, CONNECT));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
  });

  it("ignores an account.updated whose object is not the account named by event.account", async () => {
    const res = await webhook(signed(accountUpdated("acct_123", "acct_other"), CONNECT));
    expect(res.status).toBe(200);
    expect(spies.accountUpdated).not.toHaveBeenCalled();
  });

  it("does not book an unpaid completed manager checkout", async () => {
    const res = await webhook(signed({ id: "evt_unpaid", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_unpaid", object: "checkout.session", status: "complete", payment_status: "unpaid", mode: "subscription", amount_total: 4900, metadata: { userId: "manager", tier: "pro" } } } }, PLATFORM));
    expect(res.status).toBe(200);
    expect(spies.paidRecord).not.toHaveBeenCalled(); expect(spies.track).not.toHaveBeenCalled(); expect(spies.expense).not.toHaveBeenCalled();
  });
  it("processes a later asynchronous paid checkout", async () => {
    const res = await webhook(signed({ id: "evt_paid", object: "event", type: "checkout.session.async_payment_succeeded", data: { object: { id: "cs_unpaid", object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription", amount_total: 4900, metadata: { tier: "pro" } } } }, PLATFORM));
    expect(res.status).toBe(200);
    expect(spies.paidRecord).toHaveBeenCalledWith(expect.objectContaining({ id: "cs_unpaid", payment_status: "paid" }));
  });
  it("answers 500 when no secret is configured at all", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    const res = await webhook(signed(accountUpdated("acct_123"), CONNECT));
    expect(res.status).toBe(500);
  });
});
