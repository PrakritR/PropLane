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
const rows = { charge: null as unknown, payment: null as unknown };
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
    row_data: { kind: "security_deposit", paidCents: 75_000, residentEmail: "R@example.com" },
  };
  rows.payment = { stripe_charge_id: "ch_1" };
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

describe("how the money moves", () => {
  it("reverses the transfer so it comes out of the MANAGER's balance", async () => {
    // The deposit was collected as a destination charge into the manager's connected account.
    // Without reverse_transfer the refund is paid from PropLane's platform balance and the
    // manager silently keeps a deposit they no longer hold.
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amount: 75_000, reverse_transfer: true }),
      expect.anything(),
    );
  });

  it("sends an idempotency key so a double click cannot send it twice", async () => {
    await post({ chargeId: "chg-1" });
    const [, options] = refundsCreate.mock.calls[0]!;
    expect((options as { idempotencyKey?: string }).idempotencyKey).toContain("chg-1");
  });

  it("returns only what remains after an earlier partial return", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "security_deposit", paidCents: 75_000, depositReturnedCents: 50_000 },
    };
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 25_000 }),
      expect.anything(),
    );
  });

  it("records the running total so the next return sees it", async () => {
    await post({ chargeId: "chg-1" });
    const saved = upserted[0]?.row_data as Record<string, unknown>;
    expect(saved.depositReturnedCents).toBe(75_000);
    expect(saved.depositReturnAttempts).toBe(1);
  });

  it("writes no ledger entry, leaving that to the refund webhook", async () => {
    // `charge.refunded` already reverses the deposit liability, and it fires whether the refund
    // came from this button or the Stripe dashboard. Writing here too would double-count.
    await post({ chargeId: "chg-1" });
    expect(upserted.every((r) => !("entry_type" in r))).toBe(true);
  });
});

describe("what it refuses to send", () => {
  it("refuses a charge that is not a deposit", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "rent", paidCents: 75_000 },
    };
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses when the payment has not cleared", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "security_deposit", paidCents: 75_000, stripePaymentStatus: "processing" },
    };
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses a deposit with no Stripe payment behind it", async () => {
    rows.payment = null;
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses a malformed amount instead of returning everything", async () => {
    // Falling back to the full deposit because a number failed to parse is the worst possible
    // reading of a bad request.
    const res = await post({ chargeId: "chg-1", amountCents: "all" });
    expect(res.status).toBe(400);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("does not leak an internal error to the client", async () => {
    refundsCreate.mockRejectedValue(new Error("stripe: sk_live_abc123 rejected"));
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("sk_live");
  });
});
