import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  loadSnapshot: vi.fn(),
  loadRows: vi.fn(),
  setScope: vi.fn(),
  setLimit: vi.fn(),
}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.auth,
}));
vi.mock("@/lib/comms-billing/pool.server", () => ({
  loadCommsPoolSnapshot: mocks.loadSnapshot,
  loadFunderWorkspaceRows: mocks.loadRows,
  setFunderFundingScope: mocks.setScope,
  setFunderWorkspaceMonthlyLimit: mocks.setLimit,
}));

import { GET, PATCH } from "@/app/api/manager/comms-credit-pool/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/**
 * Every Billing & plan page load calls this route unconditionally
 * (`useCommsCreditPoolSummary`). Staging/production run with
 * `COMMS_CREDIT_POOL_ENABLED` off and the pool migration not applied at
 * all — its tables do not exist there. With the flag off this must answer
 * `{ poolEnabled: false }` immediately, touching neither auth nor the
 * database, rather than 503ing (or worse, erroring) on every page view.
 */
describe("GET /api/manager/comms-credit-pool with the pool flag off", () => {
  it("answers poolEnabled:false without calling auth or any pool data loader", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.poolEnabled).toBe(false);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.loadSnapshot).not.toHaveBeenCalled();
    expect(mocks.loadRows).not.toHaveBeenCalled();
  });

  it("PATCH refuses cleanly (503) without calling auth or any pool writer", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "");
    const res = await PATCH(new Request("http://localhost/api/manager/comms-credit-pool", { method: "PATCH", body: JSON.stringify({ scope: "all" }) }));
    expect(res.status).toBe(503);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.setScope).not.toHaveBeenCalled();
    expect(mocks.setLimit).not.toHaveBeenCalled();
  });
});

describe("GET /api/manager/comms-credit-pool with the pool flag on", () => {
  it("loads the real snapshot through auth as before", async () => {
    vi.stubEnv("COMMS_CREDIT_POOL_ENABLED", "1");
    mocks.auth.mockResolvedValue({ userId: "owner-1", db: {} });
    mocks.loadSnapshot.mockResolvedValue({
      tier: "pro",
      allowanceCents: 2500,
      includedRemainingCents: 2500,
      purchasedRemainingCents: 0,
      remainingCents: 2500,
      sharedAcrossWorkspaces: true,
      rollsOver: false,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      paused: false,
    });
    mocks.loadRows.mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.poolEnabled).toBe(true);
    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(mocks.loadSnapshot).toHaveBeenCalledWith({}, "owner-1");
  });
});
