import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "./_fake-db";

vi.mock("@/lib/stripe-connect", () => ({
  resolveManagerConnectAccountId: vi.fn(),
}));
vi.mock("@/lib/stripe-platform-hold.server", () => ({
  sumHeldCentsForOwner: vi.fn(),
}));

import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { sumHeldCentsForOwner } from "@/lib/stripe-platform-hold.server";
import { reconcileVendorBankingLedger } from "@/lib/vendor-banking/reconcile.server";

function entry(amount: number) {
  return { vendor_user_id: "vendor_1", amount_cents: amount };
}

describe("reconcileVendorBankingLedger", () => {
  it("matches when the ledger total equals Stripe available+pending plus held cents", async () => {
    vi.mocked(resolveManagerConnectAccountId).mockResolvedValue("acct_1");
    vi.mocked(sumHeldCentsForOwner).mockResolvedValue(1_000);
    const stripe = {
      balance: { retrieve: vi.fn().mockResolvedValue({ available: [{ amount: 4_000, currency: "usd" }], pending: [{ amount: 700, currency: "usd" }] }) },
    } as unknown as import("stripe").default;
    const db = makeFakeDb({
      vendor_banking_ledger_entries: [entry(4_000), entry(700), entry(1_000)], // sums to 5_700
    });

    const outcome = await reconcileVendorBankingLedger(stripe, db as never, "vendor_1");
    expect(outcome).toEqual({ vendorUserId: "vendor_1", matches: true, ledgerTotalCents: 5_700, stripeTotalCents: 5_700 });
    const stamp = db._tables.vendor_banking_reconciliation![0]!;
    expect(stamp.matches).toBe(true);
    expect(stamp.note).toBeNull();
  });

  it("reports a drift rather than auto-correcting anything", async () => {
    vi.mocked(resolveManagerConnectAccountId).mockResolvedValue("acct_1");
    vi.mocked(sumHeldCentsForOwner).mockResolvedValue(0);
    const stripe = {
      balance: { retrieve: vi.fn().mockResolvedValue({ available: [{ amount: 1_000, currency: "usd" }], pending: [] }) },
    } as unknown as import("stripe").default;
    const db = makeFakeDb({
      vendor_banking_ledger_entries: [entry(2_000)], // ledger says 2000, Stripe says 1000
    });

    const outcome = await reconcileVendorBankingLedger(stripe, db as never, "vendor_1");
    expect(outcome.matches).toBe(false);
    expect(outcome.ledgerTotalCents).toBe(2_000);
    expect(outcome.stripeTotalCents).toBe(1_000);
    const stamp = db._tables.vendor_banking_reconciliation![0]!;
    expect(stamp.note).toContain("1000");
  });

  it("no connected account yet: Stripe total is just the held cents", async () => {
    vi.mocked(resolveManagerConnectAccountId).mockResolvedValue(null);
    vi.mocked(sumHeldCentsForOwner).mockResolvedValue(500);
    const stripe = { balance: { retrieve: vi.fn() } } as unknown as import("stripe").default;
    const db = makeFakeDb({ vendor_banking_ledger_entries: [entry(500)] });

    const outcome = await reconcileVendorBankingLedger(stripe, db as never, "vendor_1");
    expect(outcome).toEqual({ vendorUserId: "vendor_1", matches: true, ledgerTotalCents: 500, stripeTotalCents: 500 });
    expect(stripe.balance.retrieve).not.toHaveBeenCalled();
  });
});
