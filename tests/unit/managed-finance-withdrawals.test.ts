import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeOwnerDb, type FakeRow } from "../helpers/owner-fake-db";

vi.mock("@/lib/owner-management/alerts.server", () => ({ alertManagerOfOwnerEvent: vi.fn(async () => true) }));
const account = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/stripe-connect", () => ({ retrieveManagerConnectAccountOrNull: vi.fn(async () => account.value) }));
const ready = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/stripe-payouts-readiness.server", () => ({ resolvePayoutsReadiness: () => ({ ready: ready.value }) }));

import { batchWeekKey, reconcileWithdrawals, runWeeklyVendorBatch, withdrawFromManagedFunds } from "@/lib/managed-finance/withdrawals.server";

const WS = "ws-1";
const OWNER = "own-1";
const ACCT = "acct_owner1";

function policyRows(): FakeRow[] {
  return [{
    id: "pol-1", workspace_id: WS, owner_user_id: OWNER, status: "active", signed_at: "2026-01-01T00:00:00Z", owner_share_bps: 9000,
    applies_to: "rent", leasing_fee_bps: 0, min_fee_cents: 0, reserve_target_cents: 5_000, repair_approval_threshold_cents: 25_000,
    effective_from: "2026-01-01", accepted_via: "owner_signature", terms_sha256: "h", created_at: "2026-01-01",
  }];
}

type Stripeish = ReturnType<typeof makeStripe>;
function makeStripe(over: { balance?: number; transfer?: () => unknown; payout?: () => unknown; list?: unknown[] } = {}) {
  const transfers = { create: vi.fn(async (params: Record<string, unknown>) => (over.transfer ? over.transfer() : { id: "tr_1", amount: params.amount, currency: "usd", destination: params.destination, metadata: params.metadata })), list: vi.fn(async () => ({ data: over.list ?? [] })) };
  const payouts = { create: vi.fn(async () => (over.payout ? over.payout() : { id: "po_1" })) };
  const balance = { retrieve: vi.fn(async () => ({ available: [{ currency: "usd", amount: over.balance ?? 1_000_000 }] })) };
  // The schedule decides whether this code creates the payout at all, so the fixture states it: `manual` is the
  // account PropLane pays out itself. The schedule block below stubs `automatic` and an unreadable read.
  const accounts = { retrieve: vi.fn(async (id: string) => ({ id, settings: { payouts: { schedule: { interval: "manual" } } } })) };
  return { transfers, payouts, balance, accounts } as never as { transfers: typeof transfers; payouts: typeof payouts; balance: typeof balance; accounts: typeof accounts };
}

function setup(rpc: Record<string, (args: Record<string, unknown>) => unknown> = {}, rows: Record<string, FakeRow[]> = {}) {
  const f = fakeOwnerDb(
    { managed_workspace_fee_policies: policyRows(), profiles: [{ id: OWNER, stripe_connect_account_id: ACCT }, { id: "ven-1", stripe_connect_account_id: "acct_ven1" }], ...rows },
    {
      rpc: {
        reserve_party_withdrawal: () => ({ status: "reserved", withdrawal_id: "wd-1" }),
        complete_party_withdrawal: () => ({ status: "completed" }),
        fail_party_withdrawal: () => ({ status: "failed" }),
        mark_party_withdrawal_unknown: () => true,
        party_balance: () => [{ owed: 100_000, matured: 100_000, pending: 0 }],
        ...rpc,
      },
    },
  );
  return f;
}

beforeEach(() => {
  account.value = { id: ACCT, metadata: { axis_user_id: OWNER } };
  ready.value = true;
});

const exists = (over: Record<string, unknown> = {}) => ({
  status: "exists", withdrawal_id: "wd-1", withdrawal_status: "reserved", amount_cents: 50_000, party_id: `owner:${OWNER}`,
  destination_account_id: ACCT, stripe_transfer_id: null, stripe_payout_id: null, created_at: new Date().toISOString(), ...over,
});

const owner = { kind: "owner" as const, userId: OWNER, workspaceId: WS, amountCents: 50_000, clientKey: "k1" };

describe("owner withdrawal", () => {
  it("reserves in the ledger, transfers to the owner's own account, records it, and starts the payout", async () => {
    const f = setup();
    const stripe = makeStripe();
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, withdrawalId: "wd-1", transferId: "tr_1", payoutId: "po_1", payoutPending: false });
    const reserve = f.rpcCalls.find((c) => c.name === "reserve_party_withdrawal")!.args;
    expect(reserve).toMatchObject({ p_kind: "owner", p_party: `owner:${OWNER}`, p_workspace: WS, p_amount: 50_000, p_destination: ACCT, p_reserve: 5_000 });
    expect(String(reserve.p_key)).toMatch(/^wd:owner:owner:own-1:ws-1:[0-9a-f]{40}$/);
    expect(String(reserve.p_key)).not.toContain("k1");
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    const [params, opts] = (stripe.transfers.create as unknown as { mock: { calls: Array<[Record<string, unknown>, Record<string, unknown>]> } }).mock.calls[0]!;
    expect(params).toMatchObject({ amount: 50_000, currency: "usd", destination: ACCT, transfer_group: "wd_wd-1" });
    expect(opts).toEqual({ idempotencyKey: `party-withdrawal:wd-1:owner:${OWNER}:50000` });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["reserve_party_withdrawal", "complete_party_withdrawal"]);
  });
  it("a payout that cannot start leaves the transfer recorded and tells the owner it is pending", async () => {
    const f = setup();
    const r = await withdrawFromManagedFunds(makeStripe({ payout: () => { throw new Error("bank unavailable"); } }) as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, payoutId: null, payoutPending: true, payoutError: "bank unavailable" });
    expect(f.rpcCalls.some((c) => c.name === "fail_party_withdrawal")).toBe(false);
  });
  it("asks the database for the balance and refuses before Stripe when the person has none", async () => {
    const f = setup({ reserve_party_withdrawal: () => ({ status: "insufficient", available: 1234 }) });
    const stripe = makeStripe();
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, status: 422, code: "INSUFFICIENT" });
    expect((r as { error: string }).error).toContain("$12.34");
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });
  it("one at a time: a second request while one is in flight is refused", async () => {
    const f = setup({ reserve_party_withdrawal: () => ({ status: "in_flight" }) });
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, owner)).toMatchObject({ ok: false, status: 409, code: "IN_FLIGHT" });
  });
  it("a repeated click of a completed withdrawal returns the stored result with no Stripe transfer", async () => {
    const f = setup({ reserve_party_withdrawal: () => exists({ withdrawal_status: "completed", stripe_transfer_id: "tr_old", stripe_payout_id: "po_old" }) });
    const stripe = makeStripe();
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, withdrawalId: "wd-1", transferId: "tr_old", payoutId: "po_old" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.rpcCalls.some((c) => c.name === "complete_party_withdrawal")).toBe(false);
  });
  it("refuses a failed earlier attempt with the same key", async () => {
    const f = setup({ reserve_party_withdrawal: () => ({ status: "exists", withdrawal_id: "wd-1", withdrawal_status: "failed" }) });
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, owner)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("refusals before any money is reserved", () => {
  it("payout setup not finished, or the connected account is someone else's", async () => {
    const f = setup();
    ready.value = false;
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, owner)).toMatchObject({ ok: false, status: 402, code: "PAYOUTS_NOT_READY" });
    ready.value = true;
    account.value = { id: ACCT, metadata: { axis_user_id: "someone-else" } };
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, owner)).toMatchObject({ ok: false, status: 402 });
    expect(f.rpcCalls.some((c) => c.name === "reserve_party_withdrawal")).toBe(false);
  });
  it("PropLane's Stripe balance does not hold the money yet", async () => {
    const f = setup();
    const r = await withdrawFromManagedFunds(makeStripe({ balance: 10_000 }) as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, status: 409, code: "FUNDS_CLEARING" });
    expect(f.rpcCalls).toHaveLength(0);
  });
  it("an amount under a dollar, a workspace the person does not own, and a person with no policy", async () => {
    const f = setup();
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, { ...owner, amountCents: 50 })).toMatchObject({ ok: false, status: 400 });
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, { ...owner, workspaceId: "other-ws" })).toMatchObject({ ok: false, status: 403 });
    expect(await withdrawFromManagedFunds(makeStripe() as never, f.db, { ...owner, userId: "intruder" })).toMatchObject({ ok: false, status: 403 });
    expect(f.rpcCalls.some((c) => c.name === "reserve_party_withdrawal")).toBe(false);
  });
});

describe("transfer outcomes", () => {
  it("a definitive Stripe refusal releases the reservation", async () => {
    const f = setup();
    const err = Object.assign(new Error("No such destination"), { type: "StripeInvalidRequestError" });
    const r = await withdrawFromManagedFunds(makeStripe({ transfer: () => { throw err; } }) as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["reserve_party_withdrawal", "fail_party_withdrawal"]);
  });
  it("a timeout keeps the reservation (unknown) and never reverses money that may have left", async () => {
    const f = setup();
    const err = Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
    const r = await withdrawFromManagedFunds(makeStripe({ transfer: () => { throw err; } }) as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, code: "VERIFYING" });
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["reserve_party_withdrawal", "mark_party_withdrawal_unknown"]);
  });
  it("a transfer that does not match the withdrawal is held for review, not recorded", async () => {
    const f = setup();
    const r = await withdrawFromManagedFunds(makeStripe({ transfer: () => ({ id: "tr_x", amount: 1, currency: "usd", destination: ACCT, metadata: { withdrawal_id: "wd-1" } }) }) as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, code: "VERIFYING" });
    expect(f.rpcCalls.some((c) => c.name === "complete_party_withdrawal")).toBe(false);
    expect(f.rows.owner_ledger_flags).toHaveLength(1);
  });
  it("a transfer that landed but could not be recorded stays reserved for reconciliation", async () => {
    const f = setup({ complete_party_withdrawal: () => { throw new Error("db down"); } });
    const r = await withdrawFromManagedFunds(makeStripe() as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, status: 503, code: "VERIFYING" });
    expect(f.rpcCalls.some((c) => c.name === "fail_party_withdrawal")).toBe(false);
  });
});

describe("vendor withdrawal", () => {
  it("is across workspaces (no workspace), with no reserve, to the vendor's own account", async () => {
    account.value = { id: "acct_ven1", metadata: { axis_user_id: "ven-1" } };
    const f = setup();
    const r = await withdrawFromManagedFunds(makeStripe() as never, f.db, { kind: "vendor", userId: "ven-1", amountCents: 20_000, clientKey: "v1" });
    expect(r.ok).toBe(true);
    expect(f.rpcCalls[0]!.args).toMatchObject({ p_kind: "vendor", p_party: "vendor:ven-1", p_workspace: null, p_reserve: 0, p_destination: "acct_ven1" });
  });
});

describe("reconciliation", () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const row = (over: Record<string, unknown> = {}) => ({ id: "wd-9", party_kind: "owner", party_id: `owner:${OWNER}`, workspace_id: WS, amount_cents: 50_000, destination_account_id: ACCT, status: "reserved", created_at: old, ...over });
  it("finds an existing transfer by its group and completes the withdrawal", async () => {
    const f = setup({}, { party_withdrawals: [row()] });
    const stripe = makeStripe({ list: [{ id: "tr_9", amount: 50_000, destination: ACCT, metadata: { withdrawal_id: "wd-9" } }] });
    expect(await reconcileWithdrawals(stripe as never, f.db)).toEqual({ completed: 1, failed: 0, retried: 0 });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });
  it("retries a young reservation with its own key, and fails an old one with no transfer", async () => {
    const f = setup({}, { party_withdrawals: [row({ id: "wd-1" })] });
    const stripe = makeStripe();
    expect(await reconcileWithdrawals(stripe as never, f.db)).toMatchObject({ retried: 1 });
    const g = setup({}, { party_withdrawals: [row({ created_at: new Date(Date.now() - 30 * 3600_000).toISOString() })] });
    const s2 = makeStripe();
    expect(await reconcileWithdrawals(s2 as never, g.db)).toEqual({ completed: 0, failed: 1, retried: 0 });
    expect(s2.transfers.create).not.toHaveBeenCalled();
  });
  it("a transfer in the group that does not match the reservation is flagged for a person: never failed, released or retried", async () => {
    const f = setup({}, { party_withdrawals: [row({ created_at: new Date(Date.now() - 30 * 3600_000).toISOString() })] });
    const stripe = makeStripe({ list: [{ id: "tr_x", amount: 49_999, destination: ACCT, metadata: { withdrawal_id: "wd-9" } }] });
    expect(await reconcileWithdrawals(stripe as never, f.db)).toEqual({ completed: 0, failed: 0, retried: 0 });
    expect(f.rpcCalls.some((c) => c.name === "fail_party_withdrawal")).toBe(false);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.rows.owner_ledger_flags?.[0]).toMatchObject({ check_name: "withdrawal_transfer_mismatch", subject: "wd-9" });
  });
  it("ignores withdrawals younger than two minutes (still being carried out)", async () => {
    const f = setup({}, { party_withdrawals: [row({ created_at: new Date().toISOString() })] });
    expect(await reconcileWithdrawals(makeStripe() as never, f.db)).toEqual({ completed: 0, failed: 0, retried: 0 });
  });
});

describe("weekly vendor batch", () => {
  it("keys the week on the Pacific Monday", () => {
    expect(batchWeekKey(new Date("2026-10-19T15:00:00Z"))).toBe("2026-10-19"); // Monday
    expect(batchWeekKey(new Date("2026-10-25T20:00:00Z"))).toBe("2026-10-19"); // Sunday
    expect(batchWeekKey(new Date("2026-10-26T06:00:00Z"))).toBe("2026-10-19"); // Sunday night Pacific
  });
  it("pays each vendor with at least $25 once, with the week in the key, and skips the rest", async () => {
    account.value = { id: "acct_ven1", metadata: { axis_user_id: "ven-1" } };
    const f = setup(
      { party_balance: (args) => [{ owed: args.p_party === "vendor:ven-1" ? 80_000 : 1_000, matured: args.p_party === "vendor:ven-1" ? 80_000 : 1_000, pending: 0 }] },
      { party_ledger_lines: [{ account: "vendor_payable", party_id: "vendor:ven-1" }, { account: "vendor_payable", party_id: "vendor:ven-2" }, { account: "owner_payable", party_id: `owner:${OWNER}` }] },
    );
    const out = await runWeeklyVendorBatch(makeStripe() as never, f.db, new Date("2026-10-19T15:00:00Z"));
    expect(out).toEqual({ paid: 1, skipped: 1, failed: 0 });
    const reserve = f.rpcCalls.find((c) => c.name === "reserve_party_withdrawal")!.args;
    expect(reserve).toMatchObject({ p_party: "vendor:ven-1", p_amount: 80_000, p_source: "weekly_batch" });
    expect(String(reserve.p_key)).toContain("batch:2026-10-19");
  });
});

describe("a reused idempotency key never moves money for a different request", () => {
  it("binds a manual key to the amount: the same client key with another amount is a different reservation", async () => {
    const keys: string[] = [];
    const f = setup({ reserve_party_withdrawal: (a) => { keys.push(String(a.p_key)); return { status: "reserved", withdrawal_id: `wd-${keys.length}` }; } });
    await withdrawFromManagedFunds(makeStripe() as never, f.db, owner);
    await withdrawFromManagedFunds(makeStripe() as never, f.db, { ...owner, amountCents: 60_000 });
    await withdrawFromManagedFunds(makeStripe() as never, f.db, owner);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
  });
  it("a stored reservation with a different amount is refused 409 and nothing goes to Stripe", async () => {
    const f = setup({ reserve_party_withdrawal: () => exists({ amount_cents: 999_999 }) });
    const stripe = makeStripe();
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: false, status: 409, code: "KEY_REUSED" });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.rpcCalls.map((c) => c.name)).toEqual(["reserve_party_withdrawal"]);
  });
  it("a stored reservation for another party or another destination is refused 409 and nothing goes to Stripe", async () => {
    for (const over of [{ party_id: "owner:someone-else" }, { destination_account_id: "acct_other" }]) {
      const f = setup({ reserve_party_withdrawal: () => exists(over) });
      const stripe = makeStripe();
      expect(await withdrawFromManagedFunds(stripe as never, f.db, owner)).toMatchObject({ ok: false, status: 409, code: "KEY_REUSED" });
      expect(stripe.transfers.create).not.toHaveBeenCalled();
    }
  });
  it("a young stored reservation is carried out with only the stored values, under the amount-bound Stripe key", async () => {
    const f = setup({ reserve_party_withdrawal: () => exists() });
    const stripe = makeStripe();
    expect(await withdrawFromManagedFunds(stripe as never, f.db, owner)).toMatchObject({ ok: true, transferId: "tr_1" });
    const [params, opts] = (stripe.transfers.create as unknown as { mock: { calls: Array<[Record<string, unknown>, Record<string, unknown>]> } }).mock.calls[0]!;
    expect(params).toMatchObject({ amount: 50_000, destination: ACCT });
    expect(opts).toEqual({ idempotencyKey: `party-withdrawal:wd-1:owner:${OWNER}:50000` });
  });
  it("concurrent same-key requests converge on one Stripe idempotency key and one ledger completion", async () => {
    let first = true;
    const f = setup({
      reserve_party_withdrawal: () => { if (first) { first = false; return { status: "reserved", withdrawal_id: "wd-1" }; } return exists(); },
      complete_party_withdrawal: () => ({ status: first ? "completed" : "exists" }),
    });
    const stripe = makeStripe();
    const [a, b] = await Promise.all([withdrawFromManagedFunds(stripe as never, f.db, owner), withdrawFromManagedFunds(stripe as never, f.db, owner)]);
    expect(a.ok && b.ok).toBe(true);
    const keys = (stripe.transfers.create as unknown as { mock: { calls: Array<[unknown, { idempotencyKey: string }]> } }).mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
  it("a reservation older than Stripe's idempotency window is never re-sent: reconciliation settles it", async () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    for (const over of [{ created_at: old }, { withdrawal_status: "unknown" }]) {
      const f = setup({ reserve_party_withdrawal: () => exists(over) });
      const stripe = makeStripe();
      expect(await withdrawFromManagedFunds(stripe as never, f.db, owner)).toMatchObject({ ok: false, status: 409, code: "VERIFYING" });
      expect(stripe.transfers.create).not.toHaveBeenCalled();
    }
  });
  it("a weekly batch key stays server-made and amount-free, so a retry with a changed balance is refused rather than re-sent", async () => {
    const keys: string[] = [];
    const f = setup({ reserve_party_withdrawal: (a) => { keys.push(String(a.p_key)); return exists({ party_id: "vendor:ven-1", amount_cents: 10_000 }); } });
    const base = { kind: "vendor" as const, userId: "ven-1", clientKey: "batch:2026-10-12", source: "weekly_batch" as const };
    account.value = { id: "acct_ven1", metadata: { axis_user_id: "ven-1" } };
    const stripe = makeStripe();
    expect(await withdrawFromManagedFunds(stripe as never, f.db, { ...base, amountCents: 12_000 })).toMatchObject({ ok: false, status: 409, code: "KEY_REUSED" });
    expect(keys[0]).toBe("wd:vendor:vendor:ven-1:-:batch:2026-10-12");
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });
});


describe("payout schedule of the destination account", () => {
  const withSchedule = (interval: string | undefined) => {
    const stripe = makeStripe() as never as ReturnType<typeof makeStripe> & { accounts: { retrieve: ReturnType<typeof vi.fn> } };
    (stripe as unknown as { accounts: unknown }).accounts = {
      retrieve: vi.fn(async () => ({ id: ACCT, settings: { payouts: { schedule: interval ? { interval } : {} } } })),
    };
    return stripe;
  };

  it("an automatic-payout account gets the transfer and NO manual payout; the owner is told it is on its way", async () => {
    const f = setup();
    const stripe = withSchedule("daily");
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, transferId: "tr_1", payoutId: null, payoutPending: true, payoutAutomatic: true });
    expect((r as { payoutError?: string }).payoutError).toBeUndefined();
    expect(stripe.payouts.create).not.toHaveBeenCalled();
    const complete = f.rpcCalls.find((c) => c.name === "complete_party_withdrawal")!.args;
    expect(complete).toMatchObject({ p_transfer: "tr_1", p_payout: null, p_payout_error: null });
    expect(f.rpcCalls.some((c) => c.name === "fail_party_withdrawal")).toBe(false);
  });

  it("a manual-schedule account still gets its payout", async () => {
    const f = setup();
    const stripe = withSchedule("manual");
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, payoutId: "po_1", payoutPending: false });
    expect((r as { payoutAutomatic?: boolean }).payoutAutomatic).toBeUndefined();
    expect(stripe.payouts.create).toHaveBeenCalledTimes(1);
  });

  it("an unreadable schedule creates no payout: guessing manual on an automatic account is the error this read avoids", async () => {
    const f = setup();
    const stripe = makeStripe({ payout: () => { throw new Error("You cannot create manual payouts on an automatic schedule"); } });
    (stripe as unknown as { accounts: unknown }).accounts = { retrieve: vi.fn(async () => { throw new Error("rate limited"); }) };
    const r = await withdrawFromManagedFunds(stripe as never, f.db, owner);
    expect(r).toMatchObject({ ok: true, transferId: "tr_1", payoutId: null, payoutPending: true });
    expect((r as { payoutError?: string }).payoutError).toBeUndefined();
    expect(stripe.payouts.create).not.toHaveBeenCalled();
    // The transfer stands and is recorded without a payout error; the unreadable schedule is flagged instead.
    const complete = f.rpcCalls.find((c) => c.name === "complete_party_withdrawal")!.args;
    expect(complete).toMatchObject({ p_transfer: "tr_1", p_payout: null, p_payout_error: null });
    expect(f.rpcCalls.some((c) => c.name === "fail_party_withdrawal")).toBe(false);
  });

});

describe("weekly batch and vendors without a login", () => {
  it("never pays a vendor_dir party (no account to pay) but pays a re-keyed balance under the vendor's own party", async () => {
    account.value = { id: "acct_ven1", metadata: { axis_user_id: "ven-1" } };
    const f = setup(
      { party_balance: () => [{ owed: 80_000, matured: 80_000, pending: 0 }] },
      { party_ledger_lines: [{ account: "vendor_payable", party_id: "vendor_dir:vendor-abc" }, { account: "vendor_payable", party_id: "vendor:ven-1" }] },
    );
    const out = await runWeeklyVendorBatch(makeStripe() as never, f.db, new Date("2026-10-19T15:00:00Z"));
    expect(out).toEqual({ paid: 1, skipped: 0, failed: 0 });
    const reserves = f.rpcCalls.filter((c) => c.name === "reserve_party_withdrawal");
    expect(reserves).toHaveLength(1);
    expect(reserves[0]!.args).toMatchObject({ p_party: "vendor:ven-1", p_source: "weekly_batch" });
  });
});
