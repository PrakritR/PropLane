import { describe, expect, it, vi } from "vitest";
import {
  deriveVendorFinancesBanner,
  deriveVendorFinancesFigures,
  isVendorPaymentRefundable,
  vendorWithdrawableCents,
  vendorWithdrawDisabledReason,
} from "@/lib/vendor-banking/finances";
import { VENDOR_INSTANT_WITHDRAW_FEE_LABEL, vendorInstantWithdrawFeeCents, vendorInstantWithdrawFeeQuoteCents } from "@/lib/platform-fees";

const READY = {
  availableCents: 42_500,
  withdrawableCents: 42_500,
  pendingCents: 52_000,
  onTheWayCents: 0,
  heldCents: 0,
  releasePendingCents: 0,
  recoveryOutstandingCents: 0,
  setup: { ready: true, identity: "done", bank: "done" },
};

describe("deriveVendorFinancesFigures", () => {
  it("reads every figure from the one snapshot", () => {
    expect(deriveVendorFinancesFigures(READY)).toEqual({
      availableCents: 42_500,
      pendingCents: 52_000,
      heldCents: 0,
      heldReason: null,
      onTheWayCents: 0,
      owedToPropLaneCents: 0,
    });
  });

  it("available is the withdrawable amount, never the held-inclusive figure, and never negative", () => {
    expect(vendorWithdrawableCents({ availableCents: 428_000, withdrawableCents: 100_000 })).toBe(100_000);
    expect(vendorWithdrawableCents({ availableCents: 100, withdrawableCents: -2_500 })).toBe(0);
    expect(vendorWithdrawableCents({ availableCents: 7_000 })).toBe(7_000);
  });

  it("explains held money by what it is waiting for", () => {
    const base = { ...READY, withdrawableCents: 0, heldCents: 20_500 };
    expect(deriveVendorFinancesFigures({ ...base, setup: { ready: false, identity: "done", bank: "needed" } }).heldReason).toBe("Until you add a bank");
    expect(deriveVendorFinancesFigures({ ...base, setup: { ready: false, identity: "needed", bank: "done" } }).heldReason).toBe("Until your identity is verified");
    expect(deriveVendorFinancesFigures({ ...base, releasePendingCents: 500 }).heldReason).toBe("Being released to your account");
    expect(deriveVendorFinancesFigures(base).heldReason).toBe("Held by PropLane");
  });

  it("owed to PropLane is the provider deficit plus outstanding recovery", () => {
    expect(deriveVendorFinancesFigures({ ...READY, withdrawableCents: -2_500, recoveryOutstandingCents: 7_000 }).owedToPropLaneCents).toBe(9_500);
  });
});

describe("deriveVendorFinancesBanner", () => {
  it("is null when money can move", () => {
    expect(deriveVendorFinancesBanner(READY)).toBeNull();
  });

  it("reconnect beats everything else", () => {
    const banner = deriveVendorFinancesBanner({ ...READY, needsRelink: true, setup: { ready: false, bank: "needed" } });
    expect(banner?.action).toBe("relink");
  });

  it("asks for a bank with the waiting amount", () => {
    const banner = deriveVendorFinancesBanner({ ...READY, heldCents: 20_500, setup: { ready: false, identity: "done", bank: "needed" } });
    expect(banner).toMatchObject({ action: "add-bank", actionLabel: "Add bank" });
    expect(banner?.message).toContain("$205.00 is waiting for you");
  });

  it("a pending identity has no action", () => {
    const banner = deriveVendorFinancesBanner({ ...READY, setup: { ready: false, identity: "pending", bank: "needed" } });
    expect(banner?.action).toBeNull();
  });

  it("a prior withdrawal still reconciling blocks with a reason", () => {
    expect(deriveVendorFinancesBanner({ ...READY, payoutReconciliationPending: true })?.message).toContain("prior withdrawal");
  });
});

describe("vendorWithdrawDisabledReason", () => {
  it("is null only when Withdraw is truly enabled", () => {
    expect(vendorWithdrawDisabledReason(READY, true)).toBeNull();
  });

  it.each([
    [{ ...READY, needsRelink: true }, true, "Reconnect your Stripe account first"],
    [{ ...READY, setup: { ready: false } }, true, "Finish setting up payouts first"],
    [READY, false, "Add a bank account first"],
    [{ ...READY, payoutReconciliationPending: true }, true, "Checking a prior withdrawal"],
    [{ ...READY, availableCents: 0, withdrawableCents: 0 }, true, "Nothing available to withdraw"],
  ])("explains a disabled Withdraw (%#)", (snapshot, hasBank, reason) => {
    expect(vendorWithdrawDisabledReason(snapshot, hasBank)).toBe(reason);
  });
});

describe("isVendorPaymentRefundable", () => {
  const paid = { status: "paid", amountCents: 20_500, refundedGrossCents: 0 };
  it("needs the flag", () => expect(isVendorPaymentRefundable(paid, false)).toBe(false));
  it("a settled payment with gross left is refundable", () => expect(isVendorPaymentRefundable(paid, true)).toBe(true));
  it("a partially refunded one is still refundable until nothing is left", () => {
    expect(isVendorPaymentRefundable({ ...paid, status: "partially_refunded", refundedGrossCents: 5_000 }, true)).toBe(true);
    expect(isVendorPaymentRefundable({ ...paid, status: "partially_refunded", refundedGrossCents: 20_500 }, true)).toBe(false);
  });
  it("pending, failed, skipped, refunded and missing payments are not", () => {
    for (const status of ["pending", "failed", "skipped", "refunded"]) {
      expect(isVendorPaymentRefundable({ ...paid, status }, true)).toBe(false);
    }
    expect(isVendorPaymentRefundable(null, true)).toBe(false);
  });
});

describe("the one Instant fee constant", () => {
  it("quotes $0: the fee is not collectable, so it is never quoted or booked", () => {
    for (const cents of [20_000, 1_000, 0, -5]) expect(vendorInstantWithdrawFeeQuoteCents(cents)).toBe(0);
  });

  it("the server fee and the label come from the same constants", () => {
    vi.stubEnv("VENDOR_BANKING_ENABLED", "1");
    try {
      expect(vendorInstantWithdrawFeeCents(20_000)).toBe(vendorInstantWithdrawFeeQuoteCents(20_000));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(VENDOR_INSTANT_WITHDRAW_FEE_LABEL).toBe("No PropLane fee");
  });
});

describe("frozen dispute money", () => {
  const base = {
    availableCents: 100_000, withdrawableCents: 100_000, pendingCents: 0, onTheWayCents: 0, heldCents: 0,
    setup: { ready: true, identity: "done", bank: "done" },
  };
  it("leaves Available and shows under Held with the reason Disputed", () => {
    const figures = deriveVendorFinancesFigures({ ...base, frozenDisputeCents: 30_000 });
    expect(figures.availableCents).toBe(70_000);
    expect(figures.heldCents).toBe(30_000);
    expect(figures.heldReason).toBe("Disputed");
  });
  it("combines with an existing hold reason and never moves more than Available", () => {
    const figures = deriveVendorFinancesFigures({ ...base, withdrawableCents: 10_000, availableCents: 10_000, heldCents: 5_000, frozenDisputeCents: 30_000 });
    expect(figures.availableCents).toBe(0);
    expect(figures.heldCents).toBe(15_000);
    expect(figures.heldReason).toBe("Held by PropLane · Disputed");
  });
  it("withdrawable is Available minus frozen, so the disabled reason and the server agree", () => {
    expect(vendorWithdrawableCents({ availableCents: 100, withdrawableCents: 100, frozenDisputeCents: 40 })).toBe(60);
    expect(vendorWithdrawableCents({ availableCents: 100, withdrawableCents: 100, frozenDisputeCents: 400 })).toBe(0);
    expect(vendorWithdrawDisabledReason({ ...base, frozenDisputeCents: 100_000 }, true)).toBe("Nothing available to withdraw");
  });
});
