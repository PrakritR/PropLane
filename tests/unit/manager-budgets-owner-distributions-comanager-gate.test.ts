/**
 * W003: `POST /api/manager-budgets` and `POST /api/manager-owner-distributions`
 * checked only the plan tier (`assertManagerFinancialsAccess`) before writing —
 * never a co-manager's per-property module grant. The only property gate left
 * was the active workspace's `propertyIds` list, which is populated by ANY
 * accepted co-manager membership regardless of which module was granted, so a
 * co-manager granted a module other than financials (e.g. Maintenance) on an
 * owner's house could still post a budget or distribution for it — attributed
 * to the co-manager, invisible to the owner. This proves both routes now call
 * `assertManagerFinancialsCoManagerAccess` and refuse when it does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReportsAuthContext: vi.fn(),
  assertManagerFinancialsAccess: vi.fn(),
  assertManagerFinancialsCoManagerAccess: vi.fn(),
  upsertManagerBudget: vi.fn(),
  listManagerBudgets: vi.fn(),
  createOwnerDistribution: vi.fn(),
  listOwnerDistributions: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: mocks.getReportsAuthContext,
  assertManagerFinancialsAccess: mocks.assertManagerFinancialsAccess,
}));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertManagerFinancialsCoManagerAccess: mocks.assertManagerFinancialsCoManagerAccess,
}));
vi.mock("@/lib/manager-budgets.server", () => ({
  upsertManagerBudget: mocks.upsertManagerBudget,
  listManagerBudgets: mocks.listManagerBudgets,
}));
vi.mock("@/lib/manager-owner-distributions.server", () => ({
  createOwnerDistribution: mocks.createOwnerDistribution,
  listOwnerDistributions: mocks.listOwnerDistributions,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

const MANAGER = "mgr-1";
const PROPERTY = "house-owned-by-someone-else";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getReportsAuthContext.mockResolvedValue({ role: "manager", userId: MANAGER, email: "m@example.com", db: {} });
  mocks.assertManagerFinancialsAccess.mockResolvedValue({ ok: true });
  mocks.upsertManagerBudget.mockResolvedValue({ id: "budget-1", propertyId: PROPERTY, fiscalYear: 2026, categoryCode: "maintenance", monthlyAmountsCents: {}, annualCents: 0 });
  mocks.createOwnerDistribution.mockResolvedValue({ id: "dist-1", propertyId: PROPERTY, distributionCents: 100 });
});

describe("POST /api/manager-budgets — co-manager module gate", () => {
  it("refuses when the caller has no financials grant on the named property", async () => {
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: false, status: 403, error: "Forbidden." });
    const { POST } = await import("@/app/api/manager-budgets/route");
    const res = await POST(jsonRequest("https://x.test/api/manager-budgets", { propertyId: PROPERTY, fiscalYear: 2026, categoryCode: "maintenance" }));
    expect(res.status).toBe(403);
    expect(mocks.upsertManagerBudget).not.toHaveBeenCalled();
    // The gate must resolve the REAL property owner itself (ownerManagerUserId
    // undefined) rather than trust the caller — passing the caller would
    // short-circuit the check and make it a no-op.
    expect(mocks.assertManagerFinancialsCoManagerAccess).toHaveBeenCalledWith(expect.anything(), MANAGER, PROPERTY, undefined, "edit");
  });

  it("allows the write when the gate grants financials edit", async () => {
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/manager-budgets/route");
    const res = await POST(jsonRequest("https://x.test/api/manager-budgets", { propertyId: PROPERTY, fiscalYear: 2026, categoryCode: "maintenance" }));
    expect(res.status).toBe(200);
    expect(mocks.upsertManagerBudget).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/manager-owner-distributions — co-manager module gate", () => {
  const baseBody = {
    propertyId: PROPERTY,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    beginningBalanceCents: 0,
    cashInCents: 100,
    cashOutCents: 0,
    managementFeeCents: 0,
    reserveHoldbackCents: 0,
    adjustmentsCents: 0,
  };

  it("refuses when the caller has no financials grant on the named property", async () => {
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: false, status: 403, error: "Forbidden." });
    const { POST } = await import("@/app/api/manager-owner-distributions/route");
    const res = await POST(jsonRequest("https://x.test/api/manager-owner-distributions", baseBody));
    expect(res.status).toBe(403);
    expect(mocks.createOwnerDistribution).not.toHaveBeenCalled();
    expect(mocks.assertManagerFinancialsCoManagerAccess).toHaveBeenCalledWith(expect.anything(), MANAGER, PROPERTY, undefined, "edit");
  });

  it("allows the write when the gate grants financials edit", async () => {
    mocks.assertManagerFinancialsCoManagerAccess.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/manager-owner-distributions/route");
    const res = await POST(jsonRequest("https://x.test/api/manager-owner-distributions", baseBody));
    expect(res.status).toBe(200);
    expect(mocks.createOwnerDistribution).toHaveBeenCalledTimes(1);
  });
});
