import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { makeFakeDb, type Row } from "./_fake-db";

const h = vi.hoisted(() => ({
  ledger: [] as Array<Record<string, unknown>>,
  ledgerKeys: new Set<string>(),
  shortfall: vi.fn(),
  events: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-banking/events.server", () => ({ emitVendorBankingEvent: h.events }));
vi.mock("@/lib/vendor-banking/shortfall.server", () => ({ recordVendorBankingShortfall: h.shortfall }));
vi.mock("@/lib/vendor-banking/ledger.server", () => ({
  recordVendorBankingLedgerEntry: vi.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    const key = String(entry.idempotencyKey ?? "");
    if (key && h.ledgerKeys.has(key)) return { ok: true, alreadyRecorded: true, entryId: null };
    if (key) h.ledgerKeys.add(key);
    h.ledger.push(entry);
    return { ok: true, alreadyRecorded: false, entryId: "l" };
  }),
}));

import { handleVendorBankingDispute, readVendorFrozenDisputeCents } from "@/lib/vendor-banking/disputes.server";
import { disputeOutcomeForStatus, frozenCentsForDispute, lostDisputeVendorDebitCents } from "@/lib/vendor-banking/disputes";

const payout: Row = {
  id: "payout_1", vendor_user_id: "vendor_1", manager_user_id: "mgr_1", amount_cents: 20_500, platform_fee_cents: 615,
  refunded_gross_cents: 0, stripe_charge_id: "ch_1",
};

function dispute(status: string, over: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return { id: "dp_1", charge: "ch_1", amount: 20_500, status, reason: "fraudulent", ...over } as unknown as Stripe.Dispute;
}

beforeEach(() => {
  h.ledger.length = 0;
  h.ledgerKeys.clear();
  h.shortfall.mockReset();
  h.events.mockReset();
});

describe("dispute rules", () => {
  it("freezes the disputed amount, never more than the payment", () => {
    expect(frozenCentsForDispute(5_000, 20_500)).toBe(5_000);
    expect(frozenCentsForDispute(99_999, 20_500)).toBe(20_500);
  });
  it("a lost dispute takes the net the vendor received, capped at what is unrefunded", () => {
    expect(lostDisputeVendorDebitCents({ disputeAmountCents: 20_500, payoutAmountCents: 20_500, platformFeeCents: 615, refundedGrossCents: 0 })).toBe(19_885);
    expect(lostDisputeVendorDebitCents({ disputeAmountCents: 20_500, payoutAmountCents: 20_500, platformFeeCents: 615, refundedGrossCents: 5_000 })).toBe(15_035);
  });
  it("only won / lost / warning_closed are outcomes", () => {
    expect(disputeOutcomeForStatus("won")).toBe("won");
    expect(disputeOutcomeForStatus("needs_response")).toBeNull();
    expect(disputeOutcomeForStatus("charge_refunded")).toBeNull();
  });
});

describe("handleVendorBankingDispute", () => {
  it("is not ours when the charge is no vendor payout's", async () => {
    const db = makeFakeDb({ vendor_payouts: [], vendor_banking_disputes: [] });
    expect(await handleVendorBankingDispute(db as never, dispute("needs_response"))).toBe(false);
  });

  it("opening freezes the amount (no ledger line) and notifies vendor and manager once", async () => {
    const db = makeFakeDb({ vendor_payouts: [payout], vendor_banking_disputes: [] });
    expect(await handleVendorBankingDispute(db as never, dispute("needs_response"))).toBe(true);
    expect(db._tables.vendor_banking_disputes![0]).toMatchObject({ stripe_dispute_id: "dp_1", vendor_user_id: "vendor_1", manager_user_id: "mgr_1", payout_id: "payout_1", frozen_cents: 20_500, outcome: null });
    expect(h.ledger).toHaveLength(0);
    expect(h.events).toHaveBeenCalledTimes(1);
    expect(h.events.mock.calls[0]![1]).toMatchObject({ kind: "dispute_opened", vendorUserId: "vendor_1", managerUserId: "mgr_1" });
    // a redelivery of the same event tells nobody twice
    await handleVendorBankingDispute(db as never, dispute("needs_response"));
    expect(h.events).toHaveBeenCalledTimes(1);
  });

  it("closing WON releases the freeze and writes no debit", async () => {
    const db = makeFakeDb({ vendor_payouts: [payout], vendor_banking_disputes: [] });
    await handleVendorBankingDispute(db as never, dispute("needs_response"));
    await handleVendorBankingDispute(db as never, dispute("won"));
    expect(db._tables.vendor_banking_disputes![0]).toMatchObject({ frozen_cents: 0, outcome: "won" });
    expect(h.ledger).toHaveLength(0);
    expect(h.shortfall).not.toHaveBeenCalled();
    expect(h.events.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(["dispute_opened", "dispute_closed"]);
  });

  it("closing LOST debits the vendor once (statement line + shortfall) and releases the freeze", async () => {
    const db = makeFakeDb({ vendor_payouts: [payout], vendor_banking_disputes: [] });
    await handleVendorBankingDispute(db as never, dispute("needs_response"));
    await handleVendorBankingDispute(db as never, dispute("lost"));
    await handleVendorBankingDispute(db as never, dispute("lost")); // redelivery
    expect(db._tables.vendor_banking_disputes![0]).toMatchObject({ frozen_cents: 0, outcome: "lost" });
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toMatchObject({ kind: "dispute", source: "dispute", amountCents: -19_885, idempotencyKey: "dispute:dp_1:lost" });
    expect(h.shortfall).toHaveBeenCalledTimes(1);
    expect(h.shortfall).toHaveBeenCalledWith(db, "vendor_1", 19_885);
    expect(h.events.mock.calls.filter((c) => (c[1] as { kind: string }).kind === "dispute_closed")).toHaveLength(1);
  });

  it("a late `updated` after the dispute closed cannot re-freeze it", async () => {
    const db = makeFakeDb({ vendor_payouts: [payout], vendor_banking_disputes: [] });
    await handleVendorBankingDispute(db as never, dispute("won"));
    await handleVendorBankingDispute(db as never, dispute("under_review"));
    expect(db._tables.vendor_banking_disputes![0]).toMatchObject({ frozen_cents: 0, outcome: "won" });
  });

  it("a charge matching two vendor payments needs review, never a guess", async () => {
    const db = makeFakeDb({ vendor_payouts: [payout, { ...payout, id: "payout_2" }], vendor_banking_disputes: [] });
    await expect(handleVendorBankingDispute(db as never, dispute("needs_response"))).rejects.toThrow(/review/);
  });
});

describe("readVendorFrozenDisputeCents", () => {
  it("sums the vendor's open freezes", async () => {
    const rows = [{ frozen_cents: 1_000 }, { frozen_cents: 2_500 }];
    const db = { from: () => ({ select: () => ({ eq: () => ({ gt: async () => ({ data: rows, error: null }) }) }) }) };
    expect(await readVendorFrozenDisputeCents(db as never, "vendor_1")).toBe(3_500);
  });
});
