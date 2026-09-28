import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";

/** A fully verified identity: no requirements due, nothing pending, details submitted. */
const VERIFIED_REQUIREMENTS: Stripe.Account.Requirements = {
  currently_due: [],
  past_due: [],
  pending_verification: [],
  disabled_reason: null,
} as unknown as Stripe.Account.Requirements;

const bankAccount = (over: Partial<Stripe.BankAccount> = {}): Stripe.BankAccount =>
  ({
    id: "ba_1",
    object: "bank_account",
    bank_name: "Chase",
    last4: "4321",
    status: "new",
    default_for_currency: true,
    ...over,
  }) as Stripe.BankAccount;

const card = (over: Partial<Stripe.Card> = {}): Stripe.Card =>
  ({
    id: "card_1",
    object: "card",
    brand: "Visa",
    last4: "4242",
    funding: "debit",
    default_for_currency: true,
    ...over,
  }) as Stripe.Card;

function makeAccount(opts: {
  payoutsEnabled: boolean;
  externalAccounts?: Array<Stripe.BankAccount | Stripe.Card>;
  requirements?: Partial<Stripe.Account.Requirements>;
  detailsSubmitted?: boolean;
}): Stripe.Account {
  return {
    id: "acct_1",
    payouts_enabled: opts.payoutsEnabled,
    details_submitted: opts.detailsSubmitted ?? true,
    requirements: { ...VERIFIED_REQUIREMENTS, ...opts.requirements },
    external_accounts: { data: opts.externalAccounts ?? [] },
  } as unknown as Stripe.Account;
}

describe("resolvePayoutsReadiness — bank status semantics", () => {
  it("treats a fresh ('new') default bank on a payouts_enabled account as payable — Stripe's own test success bank", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [bankAccount({ status: "new" })] });
    const readiness = resolvePayoutsReadiness(account);
    expect(readiness.bank).toBe("done");
    expect(readiness.ready).toBe(true);
  });

  it("treats a 'validated' default bank the same way", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [bankAccount({ status: "validated" })] });
    expect(resolvePayoutsReadiness(account).bank).toBe("done");
  });

  it("still treats a fully 'verified' bank as payable (unchanged baseline)", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [bankAccount({ status: "verified" })] });
    expect(resolvePayoutsReadiness(account).bank).toBe("done");
  });

  it("refuses an 'errored' default bank", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [bankAccount({ status: "errored" })] });
    const readiness = resolvePayoutsReadiness(account);
    expect(readiness.bank).toBe("needed");
    expect(readiness.ready).toBe(false);
  });

  it("refuses a 'verification_failed' default bank", () => {
    const account = makeAccount({
      payoutsEnabled: true,
      externalAccounts: [bankAccount({ status: "verification_failed" })],
    });
    expect(resolvePayoutsReadiness(account).bank).toBe("needed");
  });

  it("refuses a 'tokenized_account_number_deactivated' default bank", () => {
    const account = makeAccount({
      payoutsEnabled: true,
      externalAccounts: [bankAccount({ status: "tokenized_account_number_deactivated" as Stripe.BankAccount["status"] })],
    });
    expect(resolvePayoutsReadiness(account).bank).toBe("needed");
  });

  it("requires payouts_enabled even with a payable-status bank", () => {
    const account = makeAccount({ payoutsEnabled: false, externalAccounts: [bankAccount({ status: "new" })] });
    expect(resolvePayoutsReadiness(account).bank).toBe("needed");
  });

  it("requires an actual default external account — none present is never payable", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [] });
    expect(resolvePayoutsReadiness(account).bank).toBe("needed");
  });

  it("gates on the DEFAULT destination, not any destination — an errored default beats a verified non-default", () => {
    const account = makeAccount({
      payoutsEnabled: true,
      externalAccounts: [
        bankAccount({ id: "ba_default", status: "errored", default_for_currency: true }),
        bankAccount({ id: "ba_other", status: "verified", default_for_currency: false }),
      ],
    });
    expect(resolvePayoutsReadiness(account).bank).toBe("needed");
  });

  it("a default debit card is always payable when payouts_enabled", () => {
    const account = makeAccount({ payoutsEnabled: true, externalAccounts: [card()] });
    expect(resolvePayoutsReadiness(account).bank).toBe("done");
  });

  it("still requires identity verification even with a payable bank", () => {
    const account = makeAccount({
      payoutsEnabled: true,
      externalAccounts: [bankAccount({ status: "new" })],
      requirements: { currently_due: ["individual.dob.day"] },
    });
    const readiness = resolvePayoutsReadiness(account);
    expect(readiness.bank).toBe("done");
    expect(readiness.identity).toBe("needed");
    expect(readiness.ready).toBe(false);
  });
});
