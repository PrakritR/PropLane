/**
 * The route behind the general Refund action on a paid rent/fee charge (C023).
 *
 * Mirrors `deposit-return-route.test.ts`'s discipline (real money, no un-refund) plus C100's
 * issuer gate: the charge's owner always may refund; a co-manager needs the `bankAccount`
 * ("Bank account & payouts") grant at `edit`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getUser = vi.fn();
const refundsCreate = vi.fn();
const coManagerAccess = vi.fn();
const rows = { charge: null as unknown, payment: null as unknown };
const upserted: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  coManagerHasOwnerBankAccountAccess: (...args: unknown[]) => coManagerAccess(...args),
}));
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

const { POST } = await import("@/app/api/portal/charge-refund/route");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/portal/charge-refund", {
    method: "POST",
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  upserted.length = 0;
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  refundsCreate.mockResolvedValue({ id: "re_1" });
  coManagerAccess.mockResolvedValue(false);
  rows.charge = {
    id: "chg-1",
    manager_user_id: "mgr-1",
    status: "paid",
    row_data: { kind: "rent", paidCents: 90_000, residentEmail: "r@example.com" },
  };
  rows.payment = { stripe_charge_id: "ch_1" };
});

describe("who may issue it (C100: owner or Bank & payouts)", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ chargeId: "chg-1" })).status).toBe(401);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("the owner may refund their own charge", async () => {
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(200);
    expect(refundsCreate).toHaveBeenCalled();
  });

  it("refuses another manager without the bankAccount grant, same as a missing charge", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "co-1" } } });
    coManagerAccess.mockResolvedValue(false);
    const other = await post({ chargeId: "chg-1" });
    rows.charge = null;
    const missing = await post({ chargeId: "chg-1" });

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("allows a co-manager holding the bankAccount edit grant", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "co-1" } } });
    coManagerAccess.mockResolvedValue(true);
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(200);
    expect(coManagerAccess).toHaveBeenCalledWith(expect.anything(), "co-1", "mgr-1", "edit");
  });
});

describe("how the money moves", () => {
  it("reverses the transfer so it comes out of the manager's balance", async () => {
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amount: 90_000, reverse_transfer: true }),
      expect.anything(),
    );
  });

  it("sends an idempotency key so a double click cannot send it twice", async () => {
    await post({ chargeId: "chg-1" });
    const [, options] = refundsCreate.mock.calls[0]!;
    expect((options as { idempotencyKey?: string }).idempotencyKey).toContain("chg-1");
  });

  it("refunds only what remains after an earlier partial refund", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "rent", paidCents: 90_000, refundedCents: 60_000 },
    };
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 30_000 }), expect.anything());
  });

  it("records the running total so the next refund sees it", async () => {
    await post({ chargeId: "chg-1" });
    const saved = upserted[0]?.row_data as Record<string, unknown>;
    expect(saved.refundedCents).toBe(90_000);
    expect(saved.refundAttempts).toBe(1);
  });

  it("writes no ledger entry, leaving that to the refund webhook", async () => {
    await post({ chargeId: "chg-1" });
    expect(upserted.every((r) => !("entry_type" in r))).toBe(true);
  });
});

describe("what it refuses to send", () => {
  it("refuses a security deposit — that keeps its own Return-deposit flow", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "security_deposit", paidCents: 90_000 },
    };
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses when the payment has not cleared", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "rent", paidCents: 90_000, stripePaymentStatus: "processing" },
    };
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses a charge with no Stripe payment behind it", async () => {
    rows.payment = null;
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses a malformed amount instead of refunding everything", async () => {
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
