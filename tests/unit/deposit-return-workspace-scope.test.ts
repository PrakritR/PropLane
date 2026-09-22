/**
 * Batch A — active-workspace scoping. `POST /api/portal/deposit-return` reads
 * its charge's house directly off `property_id` (the same column the charges
 * route scopes by — no join is needed, only a column already on this table)
 * and must refuse the return when that house is outside the caller's active
 * workspace, answering identically to a missing charge (same 404, so this
 * stays a non-oracle — mirrors `deposit-return-route.test.ts`'s existing
 * "refuses another manager's deposit" case).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const refundsCreate = vi.fn();
const resolveManagerWorkspaceRowScope = vi.fn();
const rows = { charge: null as unknown, payment: null as unknown };
const upserted: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    resolveManagerWorkspaceRowScope: (...a: unknown[]) => resolveManagerWorkspaceRowScope(...(a as [])),
  };
});
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows.payment }) }),
          maybeSingle: async () => ({
            data: table === "ledger_entries" ? rows.payment : rows.charge,
          }),
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        upserted.push(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

const { POST } = await import("@/app/api/portal/deposit-return/route");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/portal/deposit-return", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  upserted.length = 0;
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  refundsCreate.mockResolvedValue({ id: "re_1" });
  rows.charge = {
    id: "chg-1",
    manager_user_id: "mgr-1",
    property_id: "prop-outside",
    status: "paid",
    row_data: { kind: "security_deposit", paidCents: 75_000, residentEmail: "r@example.com" },
  };
  rows.payment = { stripe_charge_id: "ch_1" };
});

describe("the active workspace narrows even the caller's own deposit", () => {
  it("refuses (404, same as missing) a deposit whose house is outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-inside"], untaggedOwnedVisible: true });

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Deposit not found." });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("returns the deposit when the house IS in the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-outside"], untaggedOwnedVisible: true });

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(200);
    expect(refundsCreate).toHaveBeenCalled();
  });

  it("never narrows when the workspace could not be resolved (fails open, matching activeWorkspacePropertyScope)", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: null, untaggedOwnedVisible: true });

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(200);
    expect(refundsCreate).toHaveBeenCalled();
  });
});
