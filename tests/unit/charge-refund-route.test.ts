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
const runReservedRefund = vi.fn();
const rows = { charge: null as unknown, payment: null as unknown,
  holds: [] as Array<Record<string, unknown>>, attempt: null as unknown, attemptError: false };
const upserted: Record<string, unknown>[] = [];
/** Every durable attempt write, in order: the reservation and then its provider stamp. */
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const attemptUpdates: Record<string, unknown>[] = [];
const reserve = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ refunds: { create: refundsCreate } }) }));
vi.mock("@/lib/platform-money-refund.server", () => ({
  runReservedPlatformMoneyRefund: (...args: unknown[]) => runReservedRefund(...args),
}));
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  coManagerHasOwnerBankAccountAccess: (...args: unknown[]) => coManagerAccess(...args),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return name === "reserve_household_charge_refund" ? reserve(args) : { data: { id: args.p_attempt, platform_attempt_key: args.p_key }, error: null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: (column: string) => {
          if (table === "household_charge_refund_attempts" && column !== "operation_key") throw new Error("Unexpected attempt lookup key");
          return {
          eq: () => ({ maybeSingle: async () => ({ data: rows.payment }), limit: async () => ({ data: [], error: null }) }),
          // `platform_payment_holds` decides the refund rail: empty means a legacy
          // destination charge, one row means a central platform capture.
          limit: async () => ({ data: rows.holds, error: null }),
          maybeSingle: async () => ({
            data: table === "household_charge_refund_attempts" ? rows.attempt : table === "ledger_entries" ? rows.payment : rows.charge,
            error: table === "household_charge_refund_attempts" && rows.attemptError ? { message: "lookup failed" } : null,
          }),
          };
        },
      }),
      update: (patch: Record<string, unknown>) => {
        attemptUpdates.push({ table, ...patch });
        return { eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: ATTEMPT }], error: null }) }) }) };
      },
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

const ATTEMPT = "6f1f2b9c-0d2e-4a21-9f84-4a3e2a7b1c55";

beforeEach(() => {
  vi.clearAllMocks();
  upserted.length = 0;
  rpcCalls.length = 0;
  attemptUpdates.length = 0;
  reserve.mockImplementation(() => ({
    data: { id: ATTEMPT, status: "reserved", provider_refund_id: null, platform_attempt_key: null, created: true },
    error: null,
  }));
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  refundsCreate.mockResolvedValue({ id: "re_1", status: "succeeded" });
  coManagerAccess.mockResolvedValue(false);
  rows.charge = {
    id: "chg-1",
    manager_user_id: "mgr-1",
    status: "paid",
    row_data: { kind: "rent", amountLabel: "$900.00", residentEmail: "r@example.com" },
  };
  rows.payment = { stripe_charge_id: "ch_1", amount_cents: 90_000 };
  rows.holds = [];
  rows.attempt = null;
  rows.attemptError = false;
  runReservedRefund.mockResolvedValue({ status: "succeeded", refundId: "re_central",
    recipientNetDebitCents: 90_000, vendorFeeShareCents: 0 });
});

describe("who may issue it (C100: owner or Bank & payouts)", () => {
  it("refuses a signed-out caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await post({ chargeId: "chg-1" })).status).toBe(401);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("the owner may refund their own charge", async () => {
    const res = await post({ chargeId: "chg-1" });
    // A refund is accepted, never reported complete: the money is projected onto the charge by
    // the refund webhook from re-read terminal provider evidence.
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending", refundId: "re_1" });
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
    expect(res.status).toBe(202);
    expect(coManagerAccess).toHaveBeenCalledWith(expect.anything(), "co-1", "mgr-1", "edit");
  });
});

describe("how the money moves", () => {
  /**
   * A pending refund is not refunded money and is not a failure either: it is reserved, sent,
   * and waiting on terminal evidence. Only `bind_household_charge_refund` writes the money.
   */
  it.each(["pending", "succeeded"])("accepts provider status %s without recording it as refunded", async (status) => {
    refundsCreate.mockResolvedValue({ id: "re_1", status });
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending" });
    expect(upserted).toHaveLength(0);
    expect(attemptUpdates).toEqual([expect.objectContaining({
      table: "household_charge_refund_attempts", status: "pending", provider_refund_id: "re_1",
    })]);
  });

  it.each(["failed", "canceled", null])("records provider status %s as uncertain, never refunded", async (status) => {
    refundsCreate.mockResolvedValue({ id: "re_1", status });
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "unknown" });
    expect(upserted).toHaveLength(0);
    // The budget is NOT released here: only verified terminal evidence may do that.
    expect(attemptUpdates).toEqual([expect.objectContaining({
      table: "household_charge_refund_attempts", status: "unknown",
    })]);
  });

  it("reserves durably before the provider is called", async () => {
    await post({ chargeId: "chg-1" });
    expect(rpcCalls[0]?.name).toBe("reserve_household_charge_refund");
    expect(reserve.mock.invocationCallOrder[0]!).toBeLessThan(refundsCreate.mock.invocationCallOrder[0]!);
  });

  it("refuses to send anything when the reservation is refused", async () => {
    reserve.mockImplementation(() => ({ data: null, error: { message: "active" } }));
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(409);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(upserted).toHaveLength(0);
  });

  it("resumes a replayed operation instead of sending a second provider refund", async () => {
    rows.attempt = { id: ATTEMPT, rail: "destination", stripe_payment_intent_id: null };
    reserve.mockImplementation(() => ({
      data: { id: ATTEMPT, status: "pending", provider_refund_id: "re_1", platform_attempt_key: null, created: false },
      error: null,
    }));
    const res = await post({ chargeId: "chg-1", operationId: "11111111-2222-4333-8444-555555555555" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending", refundId: "re_1" });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ p_owner: "mgr-1", p_charge: "chg-1", p_operation_key: "11111111-2222-4333-8444-555555555555", p_stripe_charge: "ch_1", p_rail: "destination", p_amount: 90_000 }));
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the existing-operation lookup fails", async () => {
    rows.attemptError = true;
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(409);
    expect(reserve).not.toHaveBeenCalled();
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(upserted).toEqual([]);
    expect(attemptUpdates).toEqual([]);
  });

  it("carries the caller's operation id as the reservation's replay identity", async () => {
    await post({ chargeId: "chg-1", operationId: "11111111-2222-4333-8444-555555555555" });
    expect(rpcCalls[0]?.args).toMatchObject({ p_operation_key: "11111111-2222-4333-8444-555555555555" });
    rpcCalls.length = 0;
    await post({ chargeId: "chg-1", operationId: "not-a-uuid" });
    expect(rpcCalls[0]?.args.p_operation_key).not.toBe("not-a-uuid");
  });

  it("reverses the transfer so it comes out of the manager's balance", async () => {
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charge: "ch_1", amount: 90_000, reverse_transfer: true }),
      expect.anything(),
    );
  });

  it("keys provider idempotency on the reserved attempt, never on the amount", async () => {
    await post({ chargeId: "chg-1" });
    const [params, options] = refundsCreate.mock.calls[0]!;
    expect((options as { idempotencyKey?: string }).idempotencyKey).toBe(`household-refund:${ATTEMPT}`);
    expect((params as { metadata?: Record<string, string> }).metadata).toMatchObject({ household_refund_attempt: ATTEMPT });
  });

  it("refunds only what remains after an earlier partial refund", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "rent", amountLabel: "$900.00", refundedCents: 60_000 },
    };
    await post({ chargeId: "chg-1" });
    expect(refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 30_000 }), expect.anything());
  });

  it("writes no money onto the charge — that is the webhook's projection", async () => {
    await post({ chargeId: "chg-1" });
    expect(upserted).toHaveLength(0);
    expect(JSON.stringify(attemptUpdates)).not.toContain("refundedCents");
  });

  /**
   * A central platform capture (`source_arbitration_v=1`) has no
   * `transfer_data.destination`, so Stripe rejects `reverse_transfer` on it and a
   * refund created outside the reservation strands the owner's hold behind
   * unresolved refund evidence.
   */
  it("refunds a central platform capture through its reservation, never with reverse_transfer", async () => {
    rows.holds = [{
      id: "6a65b330-d052-4970-86b1-ce3c98d44bd1",
      owner_user_id: "mgr-1",
      owner_role: "manager",
      stripe_charge_id: "ch_1",
      source_allocation_mode: "hold",
      source_verified_at: "2026-10-04T00:00:00Z",
      source_components: [{ source_id: "chg-1", principal_cents: 90_000 }],
    }];

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending", refundId: "re_central", amountCents: 90_000 });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(runReservedRefund).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      ownerUserId: "mgr-1",
      holdId: "6a65b330-d052-4970-86b1-ce3c98d44bd1",
      principalCents: 90_000,
      attemptKey: `household-refund:${ATTEMPT}`,
      components: [{ sourceId: "chg-1", principalCents: 90_000 }],
    }));
    // The central rail drops the caller's metadata, so the platform key is stamped on the
    // household attempt first — it is the webhook's only exact way back.
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "reserve_household_charge_refund", "stamp_household_charge_refund_platform_key",
    ]);
    expect(rpcCalls[1]?.args).toMatchObject({ p_attempt: ATTEMPT, p_key: `household-refund:${ATTEMPT}` });
    expect(upserted).toHaveLength(0);
  });

  it("records no refunded amount when the reserved central refund fails", async () => {
    rows.holds = [{
      id: "6a65b330-d052-4970-86b1-ce3c98d44bd1",
      owner_user_id: "mgr-1",
      owner_role: "manager",
      stripe_charge_id: "ch_1",
      source_allocation_mode: "hold",
      source_verified_at: "2026-10-04T00:00:00Z",
      source_components: [{ source_id: "chg-1", principal_cents: 90_000 }],
    }];
    runReservedRefund.mockResolvedValue({ status: "failed", refundId: "",
      recipientNetDebitCents: 0, vendorFeeShareCents: 0 });

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "unknown" });
    expect(upserted).toHaveLength(0);
  });

  /**
   * A destination charge also has a hold row, so the rail is picked by
   * `source_allocation_mode`. The manager already holds the money, so the transfer
   * is reversed with the refund.
   */
  it("reverses the transfer for a destination-allocation hold instead of reserving", async () => {
    rows.holds = [{
      id: "6a65b330-d052-4970-86b1-ce3c98d44bd1",
      owner_user_id: "mgr-1",
      owner_role: "manager",
      stripe_charge_id: "ch_1",
      source_allocation_mode: "destination",
      source_verified_at: "2026-10-04T00:00:00Z",
      source_components: [{ source_id: "chg-1", principal_cents: 90_000 }],
    }];

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(202);
    expect(runReservedRefund).not.toHaveBeenCalled();
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reverse_transfer: true }), expect.anything());
    // A destination refund carries the household attempt in its OWN metadata.
    expect(refundsCreate.mock.calls[0]![0].metadata).toMatchObject({ household_refund_attempt: ATTEMPT });
  });

  /**
   * A charge captured before the central rail landed can never be refunded in-app.
   * The manager must be told that, not handed a generic 500 they will retry forever.
   */
  it("answers 409 with the reason for a pre-arbitration hold, and calls no provider", async () => {
    rows.holds = [{
      id: "6a65b330-d052-4970-86b1-ce3c98d44bd1",
      owner_user_id: "mgr-1",
      owner_role: "manager",
      stripe_charge_id: "ch_1",
      source_allocation_mode: null,
      source_verified_at: null,
      source_components: null,
    }];

    const res = await post({ chargeId: "chg-1" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This payment was taken before the new payment system; its refund needs review.",
    });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(runReservedRefund).not.toHaveBeenCalled();
    expect(upserted).toHaveLength(0);
    // The rail refuses before anything is reserved, so no budget is held either.
    expect(rpcCalls).toHaveLength(0);
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
      row_data: { kind: "security_deposit", amountLabel: "$900.00" },
    };
    expect((await post({ chargeId: "chg-1" })).status).toBe(422);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("refuses when the payment has not cleared", async () => {
    rows.charge = {
      id: "chg-1",
      manager_user_id: "mgr-1",
      status: "paid",
      row_data: { kind: "rent", amountLabel: "$900.00", stripePaymentStatus: "processing" },
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

  it("does not leak an internal error to the client, and leaves the attempt uncertain", async () => {
    refundsCreate.mockRejectedValue(new Error("stripe: sk_live_abc123 rejected"));
    const res = await post({ chargeId: "chg-1" });
    expect(res.status).toBe(202);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("sk_live");
    expect(body).toContain("unknown");
    expect(attemptUpdates).toEqual([expect.objectContaining({ status: "unknown" })]);
  });
});
