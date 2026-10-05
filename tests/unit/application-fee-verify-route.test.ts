import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromoteIncompleteAfterFeeResult } from "@/lib/promote-incomplete-application-after-fee.server";

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
const update = vi.fn();
const ensureSetup = vi.fn();
const emailDelivery = vi.fn();
const emailLimit = vi.fn();
const orphanReport = vi.fn();

vi.mock("@/lib/report-orphaned-application-fee.server", () => ({
  reportOrphanedApplicationFeePayment: (...args: unknown[]) => orphanReport(...args),
}));
vi.mock("@/lib/application-fee-fulfillment.server", () => ({
  fulfillApplicationFeePayment: vi.fn(async (_db: unknown, _stripe: unknown, session: { metadata?: { includes_holding_deposit?: string; resident_email?: string } }) => {
    if (session.metadata?.includes_holding_deposit === "true") throw new Error("Combined legacy payment needs source review.");
    if (!session.metadata?.resident_email) throw new Error("Claimed payment has no saved applicant identity.");
    return { chargeId: "hc-app-fee-1", alreadyPaid: false, managerUserId: "manager-1" };
  }),
  promoteClaimedApplicationAfterFee: (...args: unknown[]) => promoteIncomplete(...args),
}));

vi.mock("@/lib/auth/resident-setup-token", () => ({
  ensureResidentSetupTokenForApplication: (...args: unknown[]) => ensureSetup(...args),
}));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: (...args: unknown[]) => emailDelivery(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => emailLimit(...args),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve, update } } }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

const markDeposit = vi.fn(async () => ({ chargeId: "hc-deposit-1", alreadyPaid: false }));
const promoteIncomplete = vi.fn<(...args: unknown[]) => Promise<PromoteIncompleteAfterFeeResult>>(async () => ({
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
      application_id: "AXIS-PROMOTED-1",
      attempt_token: "attempt-1",
      property_id: "mgr-demo-pioneer",
      resident_email: APPLICANT,
    },
    ...overrides,
  };
}

function post(body: unknown, cookie?: string) {
  return new Request("http://localhost/api/stripe/application-fee-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/stripe/application-fee-verify", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    retrieve.mockReset();
    retrieve.mockResolvedValue(paidSession());
    update.mockReset();
    update.mockResolvedValue({});
    ensureSetup.mockReset();
    ensureSetup.mockResolvedValue({
      ok: true, token: "tok_test", axisId: "AXIS-PROMOTED-1", email: "stored-applicant@example.com",
      row: { name: "Saved applicant", property: "Saved property", managerUserId: "manager-1" },
    });
    emailDelivery.mockReset();
    emailDelivery.mockResolvedValue(new Response("{}", { status: 200 }));
    emailLimit.mockReset();
    emailLimit.mockResolvedValue({ ok: true });
    orphanReport.mockReset();
    orphanReport.mockResolvedValue({ ok: true, notified: true, chargeId: "hc-app-fee-1" });
    vi.stubEnv("RESEND_API_KEY", "resend-test-key");
    markDeposit.mockClear();
    promoteIncomplete.mockClear();
    promoteIncomplete.mockResolvedValue({
      ok: true,
      promoted: true,
      axisId: "AXIS-PROMOTED-1",
      setupToken: "tok_test",
    });
  });

  it("repairs an exact bound historical payment without promoting an arbitrary application", async () => {
    const { fulfillApplicationFeePayment } = await import("@/lib/application-fee-fulfillment.server");
    vi.mocked(fulfillApplicationFeePayment).mockResolvedValueOnce({
      chargeId: "hc_historical", alreadyPaid: true, managerUserId: "manager-1", legacy: true,
    });
    retrieve.mockResolvedValueOnce(paidSession({
      metadata: { purpose: "rental_application_fee", resident_email: APPLICANT,
        property_id: "mgr-demo-pioneer" },
    }));
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paid: true, chargeId: "hc_historical", alreadyPaid: true,
      applicationPromoted: false });
    expect(promoteIncomplete).not.toHaveBeenCalled();
    expect(orphanReport).not.toHaveBeenCalled();
  });

  it("reports paid unpromoted returns with Stripe's stored email, never the caller's email", async () => {
    promoteIncomplete.mockResolvedValue({ ok: true, promoted: false, reason: "validation_failed" });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: "attacker@example.com" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ paid: true, applicationPromoted: false, emailMatches: false });
    expect(orphanReport).toHaveBeenCalledWith(expect.anything(), { sessionId: "cs_test_app_fee", expectedEmail: "applicant@example.com" });
    expect(JSON.stringify(json)).not.toMatch(/applicant@example.com|attacker@example.com/i);
    expect(emailDelivery).not.toHaveBeenCalled();
  });

  it("does not attribute a paid session missing its saved applicant identity", async () => {
    retrieve.mockResolvedValue(paidSession({ metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer" } }));
    promoteIncomplete.mockResolvedValue({ ok: true, promoted: false, reason: "no_draft" });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.error).toMatch(/saved applicant identity/);
    expect(orphanReport).not.toHaveBeenCalled();
    expect(JSON.stringify(json)).not.toMatch(/applicant@example.com/i);
  });

  it("keeps confirmed payment recoverable when server-side reporting rejects", async () => {
    promoteIncomplete.mockResolvedValue({ ok: false, error: "draft unavailable" });
    orphanReport.mockRejectedValue(new Error("private diagnostic details"));
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ paid: true, applicationPromoted: false });
    expect(logged).toHaveBeenCalledWith("[application-fee-verify] orphan_report_failed");
    expect(JSON.stringify(json)).not.toContain("private diagnostic details");
  });

  it("does not report a promoted or already submitted application as orphaned", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    await POST(post({ sessionId: "cs_test_app_fee" }));
    promoteIncomplete.mockResolvedValue({ ok: true, promoted: false, reason: "already_submitted", axisId: "AXIS-PROMOTED-1" });
    await POST(post({ sessionId: "cs_test_app_fee" }));
    expect(orphanReport).not.toHaveBeenCalled();
  });

  it("does not report unpaid sessions or substitute caller email for missing Stripe identity", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    retrieve.mockResolvedValue(paidSession({ status: "open", payment_status: "unpaid" }));
    await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    retrieve.mockResolvedValue(paidSession({ customer_email: null, metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer" } }));
    promoteIncomplete.mockResolvedValue({ ok: false, error: "Missing applicant metadata" });
    await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    expect(orphanReport).not.toHaveBeenCalled();
  });

  it("holds an earlier combined fee/deposit session for source review", async () => {
    retrieve.mockResolvedValue(
      paidSession({ metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer", resident_email: APPLICANT, includes_holding_deposit: "true" } }),
    );
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toMatch(/source review/);
    expect(markDeposit).not.toHaveBeenCalled();
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
    expect(json.applicationSetupToken).toBeUndefined();
  });

  it("does not return an account setup token to a caller with only the session id and email", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    expect((await res.json()).applicationSetupToken).toBeUndefined();
  });

  it("never returns a claim token even to the browser that created checkout", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }, "proplane_application_fee_handoff=cs_test_app_fee.caller-secret"))).json();
    expect(json.applicationSetupToken).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("tok_test");
  });

  it("fails closed when the caller sends no email at all", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee" }));
    expect((await res.json()).emailMatches).toBe(false);
  });

  it("emails the saved applicant after a cookie-less native return without exposing the token", async () => {
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.applicationSetupEmailSent).toBe(true);
    expect(json.applicationSetupToken).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("stored-applicant@example.com");
    expect(emailDelivery).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "manager-1",
      payload: expect.objectContaining({
        to: ["stored-applicant@example.com"],
        text: expect.stringContaining("token=tok_test"),
      }),
    }));
    expect(update).toHaveBeenCalledWith("cs_test_app_fee", { metadata: { application_setup_email_sent: "1" } });
  });

  it("recovers a webhook-first setup email without disclosing its token", async () => {
    promoteIncomplete.mockResolvedValue({ ok: true, promoted: false, reason: "already_submitted", axisId: "AXIS-PROMOTED-1" });
    ensureSetup.mockResolvedValue({
      ok: true, token: "current-token", axisId: "AXIS-PROMOTED-1", email: "stored-applicant@example.com",
      row: { managerUserId: "manager-1" },
    });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.applicationSetupEmailSent).toBe(true);
    expect(json.applicationSetupToken).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("current-token");
    expect(emailDelivery).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ to: ["stored-applicant@example.com"], text: expect.stringContaining("token=current-token") }),
    }));
  });

  it("does not rotate tokens or resend after a persisted successful delivery", async () => {
    retrieve.mockResolvedValue(paidSession({ metadata: {
      purpose: "rental_application_fee", property_id: "mgr-demo-pioneer", resident_email: APPLICANT,
      application_setup_email_sent: "1",
    } }));
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.applicationSetupEmailSent).toBe(true);
    expect(ensureSetup).not.toHaveBeenCalled();
    expect(emailDelivery).not.toHaveBeenCalled();
  });

  it("bounds polling before token rotation and lets failed delivery be retried later", async () => {
    emailLimit.mockResolvedValueOnce({ ok: false });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    expect((await (await POST(post({ sessionId: "cs_test_app_fee" }))).json()).applicationSetupEmailSent).toBe(false);
    expect(ensureSetup).not.toHaveBeenCalled();
    emailDelivery.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect((await (await POST(post({ sessionId: "cs_test_app_fee" }))).json()).applicationSetupEmailSent).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect((await (await POST(post({ sessionId: "cs_test_app_fee" }))).json()).applicationSetupEmailSent).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("never emails an unpersisted setup token when the application write fails", async () => {
    ensureSetup.mockResolvedValue({ ok: false, error: "Setup token persistence failed." });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.paid).toBe(true);
    expect(json.applicationPromoted).toBe(true);
    expect(json.applicationSetupEmailSent).toBe(false);
    expect(json.applicationSetupToken).toBeUndefined();
    expect(emailDelivery).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not rotate a token when email delivery is unconfigured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const json = await (await POST(post({ sessionId: "cs_test_app_fee" }))).json();
    expect(json.applicationSetupEmailSent).toBe(false);
    expect(ensureSetup).not.toHaveBeenCalled();
    expect(emailDelivery).not.toHaveBeenCalled();
  });

  it("fails closed when the session metadata carries no resident_email", async () => {
    retrieve.mockResolvedValue(
      paidSession({ metadata: { purpose: "rental_application_fee", property_id: "mgr-demo-pioneer" } }),
    );
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    expect(res.status).toBe(500);
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

  it("surfaces a fee_mismatch from the promote step as feeMismatch, never a silent promote", async () => {
    promoteIncomplete.mockResolvedValue({
      ok: true,
      promoted: false,
      reason: "fee_mismatch",
      requiredCents: 5000,
      paidCents: 0,
    });
    const { POST } = await import("@/app/api/stripe/application-fee-verify/route");
    const res = await POST(post({ sessionId: "cs_test_app_fee", expectedEmail: APPLICANT }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.paid).toBe(true);
    expect(json.applicationPromoted).toBe(false);
    expect(json.feeMismatch).toBe(true);
    expect(json.requiredCents).toBe(5000);
    expect(json.paidCents).toBe(0);
    expect(typeof json.error).toBe("string");
    expect(json.error).toContain("$50.00");
  });
});
