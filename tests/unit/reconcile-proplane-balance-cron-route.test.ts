/**
 * `/api/cron/reconcile-proplane-balance` — same secretless-access gate every
 * other money cron in this repo uses (run-autopay, comms-billing-invoice):
 * secretless access is a localhost convenience only, never a public preview
 * deployment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcilePlatformLedgerCharges: vi.fn(),
}));

vi.mock("@/lib/proplane-balance/reconcile.server", () => ({
  reconcilePlatformLedgerCharges: mocks.reconcilePlatformLedgerCharges,
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
});

describe("authorization", () => {
  it("401s without the secret when one is configured", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.reconcilePlatformLedgerCharges).not.toHaveBeenCalled();
  });

  it("fails closed on a Vercel preview deployment with no secret configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mocks.reconcilePlatformLedgerCharges).not.toHaveBeenCalled();
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
    expect(await res.json()).toEqual({ scanned: 3, credited: 1, alreadyCredited: 2, skipped: 0, errors: [] });
  });
});
