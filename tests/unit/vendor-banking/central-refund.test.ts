import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type Row } from "./_fake-db";

const h = vi.hoisted(() => ({
  runRefund: vi.fn(),
  ledger: [] as Array<Record<string, unknown>>,
  ledgerKeys: new Set<string>(),
  revenue: vi.fn(),
  gl: vi.fn(),
  events: vi.fn(),
  frozen: { cents: 0 },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/platform-money-refund.server", () => ({ runReservedPlatformMoneyRefund: h.runRefund }));
vi.mock("@/lib/stripe-connect", () => ({ resolveManagerConnectAccountId: vi.fn(async () => "acct_vendor") }));
vi.mock("@/lib/vendor-banking/disputes.server", () => ({ readVendorFrozenDisputeCents: vi.fn(async () => h.frozen.cents) }));
vi.mock("@/lib/vendor-banking/events.server", () => ({ emitVendorBankingEvent: h.events }));
vi.mock("@/lib/reports/gl-posting", () => ({ postGlVendorRefundReversal: h.gl }));
vi.mock("@/lib/vendor-banking/platform-revenue.server", () => ({ recordVendorServiceFeeRevenueReversal: h.revenue }));
vi.mock("@/lib/vendor-banking/ledger.server", () => ({
  recordVendorBankingLedgerEntry: vi.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    const key = String(entry.idempotencyKey ?? "");
    if (key && h.ledgerKeys.has(key)) return { ok: true, alreadyRecorded: true, entryId: null };
    if (key) h.ledgerKeys.add(key);
    h.ledger.push(entry);
    return { ok: true, alreadyRecorded: false, entryId: "l" };
  }),
}));

import { settleVendorRefundBooks, settleVendorRefundFromWebhook, submitVendorRefund } from "@/lib/vendor-banking/central-refund.server";

const KEY = "client-key-0001";
const ATTEMPT = `vendor-refund:payout_1:${KEY}`;

function payoutRow(over: Partial<Row> = {}): Row {
  return {
    id: "payout_1", manager_user_id: "mgr_1", vendor_user_id: "vendor_1", work_order_id: null, invoice_id: "inv_1",
    amount_cents: 20_500, platform_fee_cents: 615, refunded_gross_cents: 0, refunded_fee_cents: 0, status: "paid",
    destination: "hold", stripe_charge_id: "ch_1", stripe_transfer_id: null, platform_hold_id: "hold_1",
    created_at: new Date().toISOString(), ...over,
  };
}

function makeDb(opts: { held?: boolean; transferred?: number; payout?: Partial<Row>; extra?: Record<string, Row[]> } = {}) {
  const transferred = opts.transferred ?? 0;
  return makeFakeDb({
    vendor_payouts: [payoutRow(opts.payout)],
    platform_payment_holds: [{ id: "hold_1", owner_user_id: "vendor_1", amount_cents: 19_885, status: transferred > 0 ? "transferred" : "classified_held" }],
    platform_hold_transfer_attempts: transferred > 0 ? [{ hold_id: "hold_1", status: "created", amount_cents: transferred }] : [],
    platform_hold_refund_transfer_legs: [],
    vendor_payout_refunds: [],
    platform_hold_refund_attempts: [],
    vendor_invoices: [{ id: "inv_1", bill_id: "bill_1", refunded_cents: 0 }],
    manager_bills: [{ id: "bill_1", manager_user_id: "mgr_1", category_code: "maintenance", property_id: "prop_1", vendor_id: "v_1", refunded_cents: 0 }],
    manager_expense_reversals: [],
    ...opts.extra,
  });
}

function stripeWith(available: number) {
  return { balance: { retrieve: vi.fn(async () => ({ available: [{ currency: "usd", amount: available }] })) } } as never;
}

beforeEach(() => {
  h.runRefund.mockReset();
  h.revenue.mockReset();
  h.gl.mockReset();
  h.events.mockReset();
  h.ledger.length = 0;
  h.ledgerKeys.clear();
  h.frozen.cents = 0;
});

const base = { payoutId: "payout_1", vendorUserId: "vendor_1", clientKey: KEY };

describe("submitVendorRefund - authorization and input", () => {
  it("another vendor's payout id resolves to 404 and never reaches the rail", async () => {
    const db = makeDb();
    const result = await submitVendorRefund(stripeWith(0), db as never, { ...base, vendorUserId: "vendor_B", requestedGrossCents: 1_000 });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(h.runRefund).not.toHaveBeenCalled();
    expect(db._tables.vendor_payout_refunds).toHaveLength(0);
  });

  it("requires a usable Idempotency-Key", async () => {
    const result = await submitVendorRefund(stripeWith(0), makeDb() as never, { ...base, clientKey: "" });
    expect(result).toMatchObject({ ok: false, status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("refuses an amount over what is left to refund and a non-positive one", async () => {
    const db = makeDb();
    expect(await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 99_999 })).toMatchObject({ ok: false, status: 422 });
    expect(await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(h.runRefund).not.toHaveBeenCalled();
  });
});

describe("submitVendorRefund - cap (held / released / withdrawn / partial)", () => {
  it("refunds from held funds on the central rail with payout + hold ids and the stable key", async () => {
    h.runRefund.mockResolvedValue({ status: "pending", refundId: "re_1", recipientNetDebitCents: 0, vendorFeeShareCents: 0 });
    const db = makeDb();
    const result = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000, reason: "Partial — materials returned" });
    expect(result).toMatchObject({ ok: true, status: "pending", grossCents: 5_000, feeShareCents: 150, netDebitCents: 4_850 });
    expect(h.runRefund).toHaveBeenCalledWith(
      expect.anything(), db,
      expect.objectContaining({ ownerUserId: "vendor_1", holdId: "hold_1", payoutId: "payout_1", principalCents: 5_000, attemptKey: ATTEMPT }),
    );
    expect(db._tables.vendor_payout_refunds![0]).toMatchObject({ attempt_key: ATTEMPT, gross_cents: 5_000, status: "pending", reason: "Partial — materials returned" });
  });

  it("refunds from the released balance while it is still in the account", async () => {
    h.runRefund.mockResolvedValue({ status: "pending", refundId: "re_1", recipientNetDebitCents: 0, vendorFeeShareCents: 0 });
    const result = await submitVendorRefund(stripeWith(19_885), makeDb({ transferred: 19_885 }) as never, { ...base, requestedGrossCents: 20_500 });
    expect(result).toMatchObject({ ok: true, grossCents: 20_500 });
  });

  it("REFUSES a payment already withdrawn, before any rail call", async () => {
    const result = await submitVendorRefund(stripeWith(0), makeDb({ transferred: 19_885 }) as never, { ...base, requestedGrossCents: 5_000 });
    expect(result).toMatchObject({ ok: false, status: 409, code: "REFUND_WITHDRAWN" });
    expect(h.runRefund).not.toHaveBeenCalled();
  });

  it("caps a partly-withdrawn payment and says so", async () => {
    const result = await submitVendorRefund(stripeWith(4_850), makeDb({ transferred: 19_885 }) as never, { ...base, requestedGrossCents: 20_500 });
    expect(result).toMatchObject({ ok: false, status: 422, code: "REFUND_OVER_RECOVERABLE" });
    expect(h.runRefund).not.toHaveBeenCalled();
  });

  it("an open dispute freeze removes that money from what can be refunded", async () => {
    h.frozen.cents = 19_885;
    const result = await submitVendorRefund(stripeWith(0), makeDb() as never, { ...base, requestedGrossCents: 5_000 });
    expect(result).toMatchObject({ ok: false, status: 409, code: "REFUND_FROZEN" });
  });

  it("only one refund per payment may be in flight", async () => {
    const db = makeDb({ extra: { vendor_payout_refunds: [{ id: "r0", attempt_key: "vendor-refund:payout_1:other-key-0001", payout_id: "payout_1", vendor_user_id: "vendor_1", status: "pending", gross_cents: 100 }] } });
    const result = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    expect(result).toMatchObject({ ok: false, status: 409, code: "REFUND_IN_FLIGHT" });
  });
});

describe("submitVendorRefund - idempotency", () => {
  it("a retry or double-submit with the same key replays one reservation: one request row, same attempt key", async () => {
    h.runRefund.mockResolvedValue({ status: "pending", refundId: "re_1", recipientNetDebitCents: 0, vendorFeeShareCents: 0 });
    const db = makeDb();
    const first = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    const second = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    expect(db._tables.vendor_payout_refunds).toHaveLength(1);
    expect(h.runRefund.mock.calls.map((c) => (c[2] as { attemptKey: string }).attemptKey)).toEqual([ATTEMPT, ATTEMPT]);
  });

  it("the same key with a different amount is refused, never a second refund", async () => {
    h.runRefund.mockResolvedValue({ status: "pending", refundId: "re_1", recipientNetDebitCents: 0, vendorFeeShareCents: 0 });
    const db = makeDb();
    await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    const again = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 6_000 });
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(h.runRefund).toHaveBeenCalledTimes(1);
  });

  it("a rail refusal before any reservation fails the request and moves nothing", async () => {
    h.runRefund.mockRejectedValue(new Error("refund exceeds held source"));
    const db = makeDb();
    const result = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    expect(result).toMatchObject({ ok: false, status: 409, code: "REFUND_REFUSED" });
    expect(db._tables.vendor_payout_refunds![0]!.status).toBe("failed");
    expect(h.ledger).toHaveLength(0);
  });

  it("a rail failure after reservation keeps the request pending (it is in flight)", async () => {
    h.runRefund.mockRejectedValue(new Error("Uncertain refund needs exact provider reconciliation."));
    const db = makeDb({ extra: { platform_hold_refund_attempts: [{ id: "a1", attempt_key: ATTEMPT }] } });
    const result = await submitVendorRefund(stripeWith(0), db as never, { ...base, requestedGrossCents: 5_000 });
    expect(result).toMatchObject({ ok: false, code: "REFUND_IN_FLIGHT" });
    expect(db._tables.vendor_payout_refunds![0]!.status).toBe("pending");
  });
});

describe("settleVendorRefundBooks - vendor ledger, GL reversal, manager state", () => {
  function settledDb() {
    return makeDb({
      payout: { refunded_gross_cents: 5_000 },
      extra: {
        vendor_payout_refunds: [{ id: "r1", attempt_key: ATTEMPT, vendor_user_id: "vendor_1", manager_user_id: "mgr_1", payout_id: "payout_1", gross_cents: 5_000, fee_share_cents: 0, net_debit_cents: 0, reason: "Partial — materials returned", status: "pending", stripe_refund_id: null, books_settled_at: null, notified_at: null }],
        platform_hold_refund_attempts: [{ id: "a1", attempt_key: ATTEMPT, status: "succeeded", gross_cents: 5_000, fee_share_cents: 150, hold_debit_cents: 4_850, stripe_refund_id: "re_1", payout_id: "payout_1", owner_user_id: "vendor_1" }],
      },
    });
  }

  it("writes the vendor statement lines, the fee reversal, the manager's expense reversal and a balanced GL entry", async () => {
    const db = settledDb();
    expect(await settleVendorRefundBooks(db as never, ATTEMPT)).toEqual({ settled: true });
    // Statement: -gross refund, +fee returned => the vendor's balance gives up exactly $48.50.
    expect(h.ledger.map((l) => [l.kind, l.amountCents])).toEqual([["refund", -5_000], ["adjustment", 150]]);
    expect(h.revenue).toHaveBeenCalledWith(db, expect.objectContaining({ feeCents: 150, source: "refund", reversalId: ATTEMPT }));
    expect(db._tables.manager_expense_reversals![0]).toMatchObject({ manager_user_id: "mgr_1", amount_cents: 5_000, category_code: "maintenance", bill_id: "bill_1", attempt_key: ATTEMPT });
    expect(h.gl).toHaveBeenCalledWith(db, expect.objectContaining({ managerUserId: "mgr_1", attemptKey: ATTEMPT, categoryCode: "maintenance", amountCents: 5_000 }));
    // Invoice + bill show refunded state (the payout's own absolute figure).
    expect(db._tables.vendor_invoices![0]!.refunded_cents).toBe(5_000);
    expect(db._tables.manager_bills![0]!.refunded_cents).toBe(5_000);
    expect(db._tables.vendor_payout_refunds![0]).toMatchObject({ status: "succeeded", fee_share_cents: 150, net_debit_cents: 4_850 });
    expect(db._tables.vendor_payout_refunds![0]!.books_settled_at).toBeTruthy();
  });

  it("notifies the vendor (refund sent) and the manager (refund received)", async () => {
    await settleVendorRefundBooks(settledDb() as never, ATTEMPT);
    expect(h.events.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(["refund_sent", "refund_received"]);
  });

  it("running it again writes nothing more (webhook redelivery after the route already settled)", async () => {
    const db = settledDb();
    await settleVendorRefundBooks(db as never, ATTEMPT);
    h.gl.mockClear();
    h.events.mockClear();
    expect(await settleVendorRefundBooks(db as never, ATTEMPT)).toEqual({ settled: true });
    expect(h.ledger).toHaveLength(2);
    expect(h.gl).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
  });

  it("a half-finished run re-runs without duplicating a statement line", async () => {
    const db = settledDb();
    h.gl.mockRejectedValueOnce(new Error("gl down"));
    await expect(settleVendorRefundBooks(db as never, ATTEMPT)).rejects.toThrow("gl down");
    expect(db._tables.vendor_payout_refunds![0]!.books_settled_at).toBeNull();
    await settleVendorRefundBooks(db as never, ATTEMPT);
    expect(h.ledger).toHaveLength(2);
    expect(db._tables.vendor_payout_refunds![0]!.books_settled_at).toBeTruthy();
  });

  it("books nothing while the rail attempt is not succeeded", async () => {
    const db = settledDb();
    db._tables.platform_hold_refund_attempts![0]!.status = "reserved";
    expect(await settleVendorRefundBooks(db as never, ATTEMPT)).toEqual({ settled: false, reason: "attempt_not_succeeded" });
    expect(h.ledger).toHaveLength(0);
    expect(h.gl).not.toHaveBeenCalled();
  });

  it("refuses a request whose terms differ from the reserved attempt", async () => {
    const db = settledDb();
    db._tables.platform_hold_refund_attempts![0]!.gross_cents = 4_000;
    await expect(settleVendorRefundBooks(db as never, ATTEMPT)).rejects.toThrow(/differs/);
  });
});

describe("settleVendorRefundFromWebhook", () => {
  it("ignores an attempt that is not a vendor payout refund", async () => {
    const db = makeDb({ extra: { platform_hold_refund_attempts: [{ id: "a9", attempt_key: "household-1", payout_id: null }] } });
    expect(await settleVendorRefundFromWebhook(db as never, "a9", "succeeded")).toBe(false);
  });

  it("marks a failed vendor refund failed and books nothing", async () => {
    const db = makeDb({
      extra: {
        vendor_payout_refunds: [{ id: "r1", attempt_key: ATTEMPT, status: "pending", payout_id: "payout_1", vendor_user_id: "vendor_1", manager_user_id: "mgr_1", gross_cents: 5_000, reason: "" }],
        platform_hold_refund_attempts: [{ id: "a1", attempt_key: ATTEMPT, payout_id: "payout_1" }],
      },
    });
    expect(await settleVendorRefundFromWebhook(db as never, "a1", "failed")).toBe(true);
    expect(db._tables.vendor_payout_refunds![0]!.status).toBe("failed");
    expect(h.ledger).toHaveLength(0);
  });
});
