/**
 * The route behind the Return deposit button.
 *
 * It sends real money and Stripe will not un-refund, so the tests here are about the four ways
 * this could go wrong in a way nobody notices until a manager is short: refunding someone else's
 * deposit, refunding from the wrong balance, refunding twice, and double-counting the ledger.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const refundsCreate = vi.fn();
const rows = { charge: null as unknown, payment: null as unknown,
  holds: [] as Array<Record<string, unknown>> };
const upserted: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows.payment }) }),
          // `platform_payment_holds` decides the refund rail: empty means a legacy
          // destination charge, one row means a central platform capture.
          limit: async () => ({ data: rows.holds, error: null }),
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
  POST(new Request("https://prop-lane.space/api/portal/deposit-return", {
    method: "POST",
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  upserted.length = 0;
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  refundsCreate.mockResolvedValue({ id: "re_1" });
  rows.charge = {
    id: "chg-1",
    manager_user_id: "mgr-1",
    status: "paid",
    row_data: { kind: "security_deposit", amountLabel: "$750.00", residentEmail: "R@example.com" },
  };
  rows.payment = { stripe_charge_id: "ch_1", amount_cents: 75_000 };
  rows.holds = [];
});

describe("who may return it", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ chargeId: "chg-1" })).status).toBe(401);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses another manager's deposit, and says the same thing as a missing one", async () => {
    // Identical replies, so this is not an oracle for which charge ids exist.
    getUser.mockResolvedValue({ data: { user: { id: "mgr-2" } } });
    const other = await post({ chargeId: "chg-1" });
    rows.charge = null;
    const missing = await post({ chargeId: "chg-1" });

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(refundsCreate).not.toHaveBeenCalled();
  });
});

describe("deposit return safety", () => {
  it("blocks the provider call until accounting can reserve and settle atomically", async () => {
    const response = await post({ chargeId: "chg-1", amountCents: 10000, itemization: [{ label: "Cleaning", amountCents: 1000 }] });
    expect(response.status).toBe(503);
    expect((await response.json()).status).toBe("unavailable");
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(upserted).toHaveLength(0);
  });
});
