/**
 * `/api/cron/run-autopay` — the money cron's two gates: secretless access is a
 * localhost convenience only (a public preview deployment must never be able
 * to create off-session PaymentIntents), and the manager's own workspace
 * autopay switch is re-read on EVERY pass, so turning it off stops every
 * debit for residents who enrolled while it was on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAutopayDueCharges: vi.fn(),
  listFailedAutopayRunsEligibleForRetry: vi.fn(),
  claimRun: vi.fn(),
  chargeAutopay: vi.fn(),
  retryAutopayRun: vi.fn(),
  loadWorkspacePaymentSettingsForProperty: vi.fn(),
}));

vi.mock("@/lib/resident-autopay.server", () => ({
  listAutopayDueCharges: mocks.listAutopayDueCharges,
  listFailedAutopayRunsEligibleForRetry: mocks.listFailedAutopayRunsEligibleForRetry,
  claimRun: mocks.claimRun,
  chargeAutopay: mocks.chargeAutopay,
  retryAutopayRun: mocks.retryAutopayRun,
}));
vi.mock("@/lib/workspace-payment-settings.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace-payment-settings.server")>();
  return { ...actual, loadWorkspacePaymentSettingsForProperty: mocks.loadWorkspacePaymentSettingsForProperty };
});
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

const { GET } = await import("@/app/api/cron/run-autopay/route");

function request(secret?: string) {
  return new Request("https://prop-lane.space/api/cron/run-autopay", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const dueItem = {
  chargeId: "hc_1",
  residentUserId: "res_1",
  residentEmail: "resident@example.com",
  managerId: "mgr_1",
  propertyId: "prop_1",
  paymentMethodId: "pm_1",
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.listAutopayDueCharges.mockReset().mockResolvedValue([dueItem]);
  mocks.listFailedAutopayRunsEligibleForRetry.mockReset().mockResolvedValue([]);
  mocks.claimRun.mockReset().mockResolvedValue({ claimed: true, runId: "run_1" });
  mocks.chargeAutopay.mockReset().mockResolvedValue({ ok: true, paymentIntentId: "pi_1" });
  mocks.retryAutopayRun.mockReset().mockResolvedValue({ retried: false });
  mocks.loadWorkspacePaymentSettingsForProperty.mockReset().mockResolvedValue({ autopayEnabled: true, autopayRetryEnabled: true });
});

describe("authorization", () => {
  it("401s without the secret when one is configured", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.chargeAutopay).not.toHaveBeenCalled();
  });

  it("fails closed on a Vercel preview deployment with no secret configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.chargeAutopay).not.toHaveBeenCalled();
  });

  it("allows secretless access on localhost only", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");
    const res = await GET(request());
    expect(res.status).toBe(200);
  });
});

describe("the manager's workspace autopay switch", () => {
  it("charges when the workspace still allows autopay", async () => {
    const res = await GET(request("cron-secret"));
    expect(res.status).toBe(200);
    expect(mocks.claimRun).toHaveBeenCalledTimes(1);
    expect(mocks.chargeAutopay).toHaveBeenCalledWith({}, expect.objectContaining({ id: "run_1", chargeId: "hc_1", attempt: 1 }));
    expect(await res.json()).toMatchObject({ charged: 1, skipped: 0 });
  });

  it("skips every due charge whose workspace has since turned autopay off — no claim, no PaymentIntent", async () => {
    mocks.loadWorkspacePaymentSettingsForProperty.mockResolvedValue({ autopayEnabled: false, autopayRetryEnabled: true });
    const res = await GET(request("cron-secret"));
    expect(res.status).toBe(200);
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.chargeAutopay).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ due: 1, charged: 0, skipped: 1 });
    expect(mocks.loadWorkspacePaymentSettingsForProperty).toHaveBeenCalledWith({}, "mgr_1", "prop_1");
  });

  it("retries only when the row actually transitioned, on the attempt the claim reports", async () => {
    mocks.listAutopayDueCharges.mockResolvedValue([]);
    mocks.listFailedAutopayRunsEligibleForRetry.mockResolvedValue([
      { runId: "run_9", ...dueItem, attempt: 1, updatedAt: "2026-01-06T00:00:00.000Z" },
    ]);
    mocks.retryAutopayRun.mockResolvedValueOnce({ retried: true, attempt: 2 });
    const res = await GET(request("cron-secret"));
    expect(res.status).toBe(200);
    expect(mocks.chargeAutopay).toHaveBeenCalledWith({}, expect.objectContaining({ id: "run_9", attempt: 2 }));
    expect(await res.json()).toMatchObject({ retried: 1 });
  });

  it("does not retry when the claim reports the row was already taken by another pass", async () => {
    mocks.listAutopayDueCharges.mockResolvedValue([]);
    mocks.listFailedAutopayRunsEligibleForRetry.mockResolvedValue([
      { runId: "run_9", ...dueItem, attempt: 1, updatedAt: "2026-01-06T00:00:00.000Z" },
    ]);
    mocks.retryAutopayRun.mockResolvedValueOnce({ retried: false });
    const res = await GET(request("cron-secret"));
    expect(mocks.chargeAutopay).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ retried: 0 });
  });
});
