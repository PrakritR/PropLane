import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockCheckoutSession, mockCheckoutSessionCompletedEvent } from "../../mocks/stripe/events";

const recordPaidManagerCheckoutSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "stripe-signature": "sig_test" })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(),
}));

vi.mock("@/lib/manager-purchase-from-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-purchase-from-session")>()),
  recordPaidManagerCheckoutSession,
}));

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  applyScheduledDowngradeAfterInvoicePaid: vi.fn(),
  reconcileManagerPurchaseByStripeSubscriptionId: vi.fn(),
  reconcileManagerPurchaseWithStripe: vi.fn(),
}));

vi.mock("@/lib/stripe-application-fee", () => ({
  markApplicationFeePaidFromStripeSession: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/stripe-household-charge", () => ({
  markHouseholdChargePaidFromStripeSession: vi.fn().mockResolvedValue({ ok: true }),
}));

import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { POST as webhook } from "@/app/api/stripe/webhook/route";

function legacyPurchaseDb(row: { user_id: string | null; manager_id: string; email: string }) {
  let matchColumn = "";
  const query = {
    select: vi.fn(),
    eq: vi.fn((column: string) => {
      matchColumn = column;
      return query;
    }),
    or: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({
      data: matchColumn === "stripe_checkout_session_id" ? null : { id: "purchase-legacy", ...row },
      error: null,
    })),
  };
  query.select.mockReturnValue(query);
  return { from: vi.fn(() => query) };
}

function checkoutRequest() {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "sig_test" },
  });
}

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("returns 400 without stripe signature", async () => {
    const { headers } = await import("next/headers");
    vi.mocked(headers).mockResolvedValueOnce(new Headers());
    const req = new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" });
    const res = await webhook(req);
    expect(res.status).toBe(400);
  });

  it("processes checkout.session.completed", async () => {
    const session = mockCheckoutSessionCompletedEvent(
      mockCheckoutSession({
        id: "cs_test",
        customer_email: "owner@example.com",
        metadata: { tier: "pro", manager_id: "MGR-A", userId: "owner-a" },
      }),
    ).data.object;
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(legacyPurchaseDb({
      user_id: "owner-a", manager_id: "MGR-A", email: "owner@example.com",
    }) as never);
    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          type: "checkout.session.completed",
          data: { object: session },
        }),
      },
    } as never);

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "stripe-signature": "sig_test" },
    });
    const res = await webhook(req);
    expect(res.status).toBe(200);
    expect(recordPaidManagerCheckoutSession).toHaveBeenCalled();
  });

  it("runs the real webhook owner gate for a hosted legacy session without a reservation", async () => {
    const session = mockCheckoutSession({
      id: "cs_legacy_auth",
      customer_email: "owner@example.com",
      metadata: { tier: "pro", manager_id: "MGR-A", userId: "owner-a" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(legacyPurchaseDb({
      user_id: "owner-a", manager_id: "MGR-A", email: "owner@example.com",
    }) as never);
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue(mockCheckoutSessionCompletedEvent(session)) },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(200);
    expect(recordPaidManagerCheckoutSession).toHaveBeenCalledWith(session);
  });

  it("runs the real webhook owner gate for a guest legacy session without a reservation", async () => {
    const session = mockCheckoutSession({
      id: "cs_legacy_guest",
      customer_email: "guest@example.com",
      metadata: { tier: "pro", manager_id: "MGR-G" },
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(legacyPurchaseDb({
      user_id: null, manager_id: "MGR-G", email: "guest@example.com",
    }) as never);
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue(mockCheckoutSessionCompletedEvent(session)) },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(200);
    expect(recordPaidManagerCheckoutSession).toHaveBeenCalledWith(session);
  });

  it("returns a retryable failure for an unmatched lost dispute without fetching its charge", async () => {
    const query = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({ from: vi.fn(() => query) } as never);
    const retrieve = vi.fn();
    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          id: "evt_dispute_lost",
          type: "charge.dispute.closed",
          data: {
            object: {
              id: "dp_lost",
              status: "lost",
              charge: "ch_credit",
              payment_intent: "pi_credit",
            },
          },
        }),
      },
      charges: { retrieve },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "Credit dispute ownership is pending." });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("acknowledges a ledger-owned ordinary dispute after one idempotent local record", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      from: vi.fn((table: string) => {
        if (table === "stripe_disputes") return { upsert };
        const query = {
          select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({
            data: table === "ledger_entries"
              ? { id: "ledger-payment", manager_user_id: "manager-ordinary", source_charge_id: "charge-row" }
              : null,
            error: null,
          }),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const retrieve = vi.fn();
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue({
        id: "evt_ordinary_dispute",
        type: "charge.dispute.closed",
        data: { object: { id: "dp_ordinary", status: "lost", charge: "ch_rent", payment_intent: "pi_rent", amount: 12000 } },
      }) },
      charges: { retrieve },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("returns 500 when an ordinary dispute record cannot be persisted so Stripe retries it", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: "write unavailable" } });
    const db = {
      from: vi.fn((table: string) => {
        if (table === "stripe_disputes") return { upsert };
        const query = {
          select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({
            data: table === "ledger_entries"
              ? { id: "ledger-payment", manager_user_id: "manager-ordinary", source_charge_id: "charge-row" }
              : null,
            error: null,
          }),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const retrieve = vi.fn();
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue({
        id: "evt_ordinary_dispute_retry",
        type: "charge.dispute.closed",
        data: { object: { id: "dp_retry", status: "lost", charge: "ch_rent", payment_intent: "pi_rent", amount: 12000 } },
      }) },
      charges: { retrieve },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(500);
    expect(upsert).toHaveBeenCalledOnce();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("captures a classified ledger-owned dispute without provider or ordinary writes", async () => {
    vi.mocked(captureTestWorkspaceEffectForUser).mockResolvedValueOnce({ captured: true } as never);
    const upsert = vi.fn();
    const db = {
      from: vi.fn((table: string) => {
        if (table === "stripe_disputes") return { upsert };
        const query = {
          select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({
            data: table === "ledger_entries"
              ? { id: "ledger-test", manager_user_id: "manager-test", source_charge_id: "charge-test" }
              : null,
            error: null,
          }),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const retrieve = vi.fn();
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue({
        id: "evt_classified_dispute",
        type: "charge.dispute.created",
        data: { object: { id: "dp_test", status: "needs_response", charge: "ch_test", payment_intent: "pi_test", amount: 500 } },
      }) },
      charges: { retrieve },
    } as never);

    const res = await webhook(checkoutRequest());

    expect(res.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("retries an unknown dispute and acknowledges its replay after credit fulfillment binds the owner", async () => {
    let creditBound = false;
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const db = {
      rpc,
      from: vi.fn((table: string) => {
        const query = {
          select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({
            data: table === "manager_comms_credit_purchases" && creditBound
              ? { id: "purchase-credit", credit_cents: 500, manager_user_id: "manager-credit" }
              : null,
            error: null,
          })),
        };
        query.select.mockReturnValue(query);
        query.eq.mockReturnValue(query);
        return query;
      }),
    };
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const retrieve = vi.fn();
    const event = {
      id: "evt_credit_dispute",
      type: "charge.dispute.closed",
      data: { object: { id: "dp_credit", status: "lost", charge: "ch_credit", payment_intent: "pi_credit", amount: 500 } },
    };
    vi.mocked(getStripe).mockReturnValue({
      webhooks: { constructEvent: vi.fn().mockReturnValue(event) },
      charges: { retrieve },
    } as never);

    expect((await webhook(checkoutRequest())).status).toBe(500);
    creditBound = true;
    expect((await webhook(checkoutRequest())).status).toBe(200);

    expect(rpc).toHaveBeenCalledWith("reverse_comms_credit_purchase", {
      p_payment_intent: "pi_credit",
      p_reversed: 500,
      p_event: "evt_credit_dispute",
      p_reason: "dispute",
    });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid signature", async () => {
    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockImplementation(() => {
          throw new Error("Invalid signature");
        }),
      },
    } as never);

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "bad" },
    });
    const res = await webhook(req);
    expect(res.status).toBe(400);
  });
});
