import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ ok: true })),
  clientIpFrom: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/manager-purchase-from-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-purchase-from-session")>()),
  recordPaidManagerCheckoutSession: vi.fn().mockResolvedValue(undefined),
}));

import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";
import { rateLimit } from "@/lib/rate-limit";
import { GET as checkoutPreview } from "@/app/api/auth/manager-checkout-preview/route";

function makeDbWithPurchase(row: { manager_id?: string; email?: string; full_name?: string; tier?: string } | null) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
        }),
      }),
    }),
  };
}

describe("GET /api/auth/manager-checkout-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockReturnValue({ ok: true } as ReturnType<typeof rateLimit>);
  });

  it("returns 400 when session_id is missing", async () => {
    const req = new Request("http://localhost/api/auth/manager-checkout-preview");
    const res = await checkoutPreview(req);
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(rateLimit).mockReturnValue({ ok: false } as ReturnType<typeof rateLimit>);
    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=cs_test");
    const res = await checkoutPreview(req);
    expect(res.status).toBe(429);
  });

  it("reads axis_intent session from DB", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbWithPurchase({ manager_id: "MGR-INTENT-01", email: "mgr@example.com", full_name: "Test Mgr", tier: "pro" }) as never,
    );

    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=axis_intent_abc123");
    const res = await checkoutPreview(req);
    const { status, data } = await parseJsonResponse<{ managerId?: string; email?: string; tier?: string }>(res);

    expect(status).toBe(200);
    expect(data.managerId).toBe("MGR-INTENT-01");
    expect(data.email).toBe("mgr@example.com");
    expect(data.tier).toBe("pro");
  });

  it("returns 400 when axis_intent session is unknown", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbWithPurchase(null) as never);

    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=axis_intent_unknown");
    const res = await checkoutPreview(req);
    expect(res.status).toBe(400);
  });

  it("returns preview from completed Stripe session", async () => {
    vi.mocked(getStripe).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue({
            id: "cs_test_done",
            payment_status: "paid",
            status: "complete",
            metadata: { manager_id: "MGR-STRIPE-01", email: "paid@example.com", full_name: "Stripe Mgr", tier: "business" },
            customer_details: { email: "paid@example.com" },
            customer_email: null,
          }),
        },
      },
    } as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbWithPurchase(null) as never);

    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=cs_test_done");
    const res = await checkoutPreview(req);
    const { status, data } = await parseJsonResponse<{ managerId?: string; email?: string; tier?: string }>(res);

    expect(status).toBe(200);
    expect(data.managerId).toBe("MGR-STRIPE-01");
    expect(data.email).toBe("paid@example.com");
    expect(data.tier).toBe("business");
  });

  it("does not expose or record a completed-but-unpaid checkout session", async () => {
    vi.mocked(getStripe).mockReturnValue({
      checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({
        id: "cs_test_unpaid_complete",
        payment_status: "unpaid",
        status: "complete",
        metadata: { manager_id: "MGR-UNPAID", email: "unpaid@example.invalid", full_name: "Unpaid Manager", tier: "business" },
        customer_details: { email: "unpaid@example.invalid" },
      }) } },
    } as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbWithPurchase({
      manager_id: "MGR-UNPAID", email: "unpaid@example.invalid", full_name: "Unpaid Manager", tier: "business",
    }) as never);

    const res = await checkoutPreview(new Request("http://localhost/api/auth/manager-checkout-preview?session_id=cs_test_unpaid_complete"));
    const { status, data } = await parseJsonResponse<{ managerId?: string; email?: string; fullName?: string; error?: string }>(res);

    expect(status).toBe(400);
    expect(data.managerId).toBeUndefined();
    expect(data.email).toBeUndefined();
    expect(data.fullName).toBeUndefined();
    expect(recordPaidManagerCheckoutSession).not.toHaveBeenCalled();
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  // A stored purchase row is NOT a substitute for reading the session at Stripe: the
  // preview used to fall back to the row when `sessions.retrieve` threw, which handed a
  // manager id and email out on the strength of an unverified session id. The row is no
  // longer consulted, so an unreadable session is refused even when a row exists.
  it("refuses an unreadable Stripe session even when a purchase row exists", async () => {
    vi.mocked(getStripe).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockRejectedValue(new Error("No such checkout.session")),
        },
      },
    } as never);
    const db = makeDbWithPurchase({ manager_id: "MGR-FALLBACK", email: "fallback@example.com", tier: "pro" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=cs_live_failing_session");
    const res = await checkoutPreview(req);
    const { status, data } = await parseJsonResponse<{ managerId?: string; email?: string }>(res);

    expect(status).toBe(500);
    expect(data.managerId).toBeUndefined();
    expect(data.email).toBeUndefined();
    expect(recordPaidManagerCheckoutSession).not.toHaveBeenCalled();
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("returns 500 without database access when Stripe cannot verify the session", async () => {
    vi.mocked(getStripe).mockReturnValue({
      checkout: {
        sessions: {
          retrieve: vi.fn().mockRejectedValue(new Error("No such checkout.session")),
        },
      },
    } as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbWithPurchase(null) as never);

    const req = new Request("http://localhost/api/auth/manager-checkout-preview?session_id=cs_live_totally_unknown");
    const res = await checkoutPreview(req);
    expect(res.status).toBe(500);
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
    expect(recordPaidManagerCheckoutSession).not.toHaveBeenCalled();
  });
});
