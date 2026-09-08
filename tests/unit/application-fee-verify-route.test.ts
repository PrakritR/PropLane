import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level coverage for POST /api/stripe/application-fee-verify — the
 * unauthenticated return-URL endpoint the rental application wizard calls after
 * Stripe Checkout (now card / Apple Pay, previously ACH).
 *
 * Two properties matter and neither is exercised by the wizard's own tests:
 *  - the identity guard is server-side and fails CLOSED (`emailMatches`), so a
 *    stranger holding someone else's session id can't unlock their application;
 *  - the response never echoes the applicant's email back to that anonymous
 *    caller, and the session id travels in the BODY, so it never lands in a
 *    CDN/proxy access log. The legacy `GET ?session_id=…` shape is gone.
 */

const retrieve = vi.fn();

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve } } }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

const markDeposit = vi.fn(async () => ({ chargeId: "hc-deposit-1", alreadyPaid: false }));
const promoteIncomplete = vi.fn(async () => ({
  ok: true,
  promoted: true,
  axisId: "AXIS-PROMOTED-1",
  setupToken: "tok_test",
}));

vi.mock("@/lib/stripe-application-fee", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stripe-application-fee")>()),
  markApplicationFeePaidFromStripeSession: async () => ({ chargeId: "hc-app-fee-1", alreadyPaid: false }),
  markApplicationDepositPaidFromStripeSession: markDeposit,
}));

vi.mock("@/lib/promote-incomplete-application-after-fee.server", () => ({
  promoteIncompleteApplicationAfterFeePaid: (...args: unknown[]) => promoteIncomplete(...args),
}));

const APPLICANT = "Applicant@Example.com";

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_app_fee",
    status: "complete",
    payment_status: "paid",
    customer_email: APPLICANT,
    metadata: {
      purpose: "rental_application_fee",
      property_id: "mgr-demo-pioneer",
      resident_email: APPLICANT,
    },
    ...overrides,
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/stripe/application-fee-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/stripe/application-fee-verify", () => {
  beforeEach(() => {
    retrieve.mockReset();
    retrieve.mockResolvedValue(paidSession());
    markDeposit.mockClear();
    promoteIncomplete.mockClear();
    promoteIncomplete.mockResolvedValue({
      ok: true,
      promoted: true,
      axisId: "AXIS-PROMOTED-1",
      setupToken: "tok_test",
    });
  });

  it("also marks the holding deposit paid — and returns its charge id — on a combined session", async () => {
    retrieve.mockResolvedValue(
      paidSession({ metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer", resident_email: APPLICANT, includes_holding_deposit: "true" } }),
    );
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.chargeId).toBe("hc-app-fee-1");
    expect(json.depositChargeId).toBe("hc-deposit-1");
    expect(markDeposit).toHaveBeenCalledTimes(1);
  });

  it("never calls the deposit-marking path for a plain (non-combined) session", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.depositChargeId ?? null).toBeNull();
    expect(markDeposit).not.toHaveBeenCalled();
  });

  it("confirms the payment and reports a match without ever echoing the applicant email", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.paid).toBe(true);
    expect(json.emailMatches).toBe(true);
    expect(json.propertyId).toBe("mgr-demo-pioneer");
    expect(json.chargeId).toBe("hc-app-fee-1");
    expect(json.applicationPromoted).toBe(true);
    expect(json.applicationAxisId).toBe("AXIS-PROMOTED-1");
    // The whole payload, not just the removed `residentEmail` key.
    expect(JSON.stringify(json).toLowerCase()).not.toContain("applicant@example.com");
  });

  it("normalizes case and surrounding whitespace before comparing", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: "  applicant@EXAMPLE.com  " }));
    expect((await res.json()).emailMatches).toBe(true);
  });

  it("reports no match for a different email — a stolen session id unlocks nothing", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: "attacker@example.com" }));
    const json = await res.json();
    expect(json.paid).toBe(true);
    expect(json.emailMatches).toBe(false);
  });

  it("fails closed when the caller sends no email at all", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee" }));
    expect((await res.json()).emailMatches).toBe(false);
  });

  it("falls back to customer_email when the session metadata carries no resident_email", async () => {
    retrieve.mockResolvedValue(
      paidSession({ metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer" } }),
    );
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    expect((await res.json()).emailMatches).toBe(true);
  });

  it("rejects a request with no sessionId in the body", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ expectedEmail: APPLICANT }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing sessionId");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("no longer exposes the legacy GET ?session_id=… shape", async () => {
    const mod = await import("@/app/api/stripe/application-fee-verify/route");
    expect("GET" in mod).toBe(false);
  });
});
