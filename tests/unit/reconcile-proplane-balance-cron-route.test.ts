/**
 * `/api/cron/reconcile-proplane-balance` — same secretless-access gate every
 * other money cron in this repo uses (run-autopay, comms-billing-invoice):
 * secretless access is a localhost convenience only, never a public preview
 * deployment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcilePlatformLedgerCharges: vi.fn(),
  reconcileReservedPlatformOwnerRecovery: vi.fn(),
  reconcileUnhydratedCentralSourceMirrors: vi.fn(),
  reconcileReservedPlatformHoldTransfers: vi.fn(),
  reconcileClassifiedBalanceWithdrawals: vi.fn(),
}));

vi.mock("@/lib/proplane-balance/reconcile.server", () => ({
  reconcilePlatformLedgerCharges: mocks.reconcilePlatformLedgerCharges,
}));
vi.mock("@/lib/platform-owner-recovery.server", () => ({
  reconcileReservedPlatformOwnerRecovery: mocks.reconcileReservedPlatformOwnerRecovery,
  reconcileUnhydratedCentralSourceMirrors: mocks.reconcileUnhydratedCentralSourceMirrors,
}));
vi.mock("@/lib/platform-hold-release.server", () => ({
  reconcileReservedPlatformHoldTransfers: mocks.reconcileReservedPlatformHoldTransfers,
}));
vi.mock("@/lib/proplane-balance/withdraw-reconcile.server", () => ({
  reconcileClassifiedBalanceWithdrawals: mocks.reconcileClassifiedBalanceWithdrawals,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));

const { GET } = await import("@/app/api/cron/reconcile-proplane-balance/route");

function request(secret?: string) {
  return new Request("https://prop-lane.space/api/cron/reconcile-proplane-balance", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.reconcilePlatformLedgerCharges.mockReset().mockResolvedValue({
    scanned: 3,
    credited: 1,
    alreadyCredited: 2,
    skipped: 0,
    errors: [],
  });
  mocks.reconcileReservedPlatformOwnerRecovery.mockReset().mockResolvedValue({
    scanned: 1, settled: 0, pending: 1, truncated: false, errors: [],
  });
  mocks.reconcileUnhydratedCentralSourceMirrors.mockReset().mockResolvedValue({
    scanned: 1, hydrated: 0, pending: 1, truncated: false, errors: [],
  });
  mocks.reconcileReservedPlatformHoldTransfers.mockReset().mockResolvedValue({
    scanned: 1, transferred: 1, pending: 0, truncated: false, errors: [],
  });
  mocks.reconcileClassifiedBalanceWithdrawals.mockReset().mockResolvedValue({
    scanned: 2, transfers: 1, payouts: 1, pending: 0, errors: [],
  });
});

/**
 * `reconcileReservedPlatformHoldTransfers` and `reconcileClassifiedBalanceWithdrawals`
 * are the only paths that finish money left in an unknown provider state, so an
 * earlier stage's transient list-read failure must not skip them.
 */
describe("one failing stage does not skip the rest", () => {
  it("still runs every later stage and reports the failure", async () => {
    mocks.reconcileReservedPlatformOwnerRecovery.mockRejectedValue(
      new Error("Could not load reserved owner recovery sources."));

    const res = await GET(request("cron-secret"));

    expect(res.status).toBe(500);
    expect(mocks.reconcileUnhydratedCentralSourceMirrors).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileReservedPlatformHoldTransfers).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileClassifiedBalanceWithdrawals).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.ownerRecovery).toBeNull();
    expect(body.stageErrors).toEqual([
      { stage: "ownerRecovery", message: "Could not load reserved owner recovery sources." },
    ]);
    // The first reconciler's own per-row report is not clobbered by the stage report.
    expect(body.errors).toEqual([]);
    expect(body.holdTransfers).toMatchObject({ transferred: 1 });
  });

  it("reports every failed stage and keeps the successful ones", async () => {
    mocks.reconcilePlatformLedgerCharges.mockRejectedValue(new Error("ledger read failed"));
    mocks.reconcileClassifiedBalanceWithdrawals.mockRejectedValue(new Error("withdrawal read failed"));

    const res = await GET(request("cron-secret"));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.stageErrors).toEqual([
      { stage: "ledgerCharges", message: "ledger read failed" },
      { stage: "withdrawals", message: "withdrawal read failed" },
    ]);
    expect(body.holdTransfers).toMatchObject({ transferred: 1 });
    expect(body.withdrawals).toBeNull();
  });
});

describe("authorization", () => {
  it("401s without the secret when one is configured", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.reconcilePlatformLedgerCharges).not.toHaveBeenCalled();
    expect(mocks.reconcileReservedPlatformOwnerRecovery).not.toHaveBeenCalled();
  });

  it("fails closed on a Vercel preview deployment with no secret configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.reconcilePlatformLedgerCharges).not.toHaveBeenCalled();
    expect(mocks.reconcileReservedPlatformOwnerRecovery).not.toHaveBeenCalled();
  });

  it("allows secretless access on localhost only", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");
    const res = await GET(request());
    expect(res.status).toBe(200);
  });

  it("runs the reconciliation and returns its summary with the right secret", async () => {
    const res = await GET(request("cron-secret"));
    expect(res.status).toBe(200);
    expect(mocks.reconcilePlatformLedgerCharges).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileReservedPlatformOwnerRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileUnhydratedCentralSourceMirrors).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileReservedPlatformHoldTransfers).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileClassifiedBalanceWithdrawals).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ scanned: 3, credited: 1, alreadyCredited: 2,
      skipped: 0, errors: [], ownerRecovery: {
        scanned: 1, settled: 0, pending: 1, truncated: false, errors: [],
      }, centralAvailability: {
        scanned: 1, hydrated: 0, pending: 1, truncated: false, errors: [],
      }, holdTransfers: {
        scanned: 1, transferred: 1, pending: 0, truncated: false, errors: [],
      }, withdrawals: {
        scanned: 2, transfers: 1, payouts: 1, pending: 0, errors: [],
      } });
  });
});
