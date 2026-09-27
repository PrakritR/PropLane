/**
 * Pure decisions behind the per-workspace Stripe Connect architecture
 * (C186-C189, C045), entirely gated by WORKSPACE_CONNECT_ENABLED (default
 * off). These never call Stripe or the database.
 */
import { describe, expect, it } from "vitest";
import {
  decideAutoPayoutSwitchRequiresConfirmation,
  decideBillingFundingSource,
  nextWorkspacePayoutMode,
} from "@/lib/workspace-connect/decisions";

describe("decideBillingFundingSource (C045)", () => {
  it("with the flag off, always uses the card — reproduces today's only behavior", () => {
    const decision = decideBillingFundingSource({
      amountCents: 2000,
      workspaceConnectEnabled: false,
      availableBalanceCents: 100_000,
      hasCardOnFile: true,
    });
    expect(decision).toEqual({ source: "card", amountCents: 2000, reason: "balance_disabled" });
  });

  it("with the flag on and enough balance, pays from the balance", () => {
    const decision = decideBillingFundingSource({
      amountCents: 2000,
      workspaceConnectEnabled: true,
      availableBalanceCents: 5000,
      hasCardOnFile: true,
    });
    expect(decision).toEqual({ source: "balance", amountCents: 2000 });
  });

  it("falls back to the card on file automatically when the balance is short (recommended option)", () => {
    const decision = decideBillingFundingSource({
      amountCents: 2000,
      workspaceConnectEnabled: true,
      availableBalanceCents: 500,
      hasCardOnFile: true,
    });
    expect(decision).toEqual({ source: "card", amountCents: 2000, reason: "insufficient_balance" });
  });

  it("blocks with the exact shortfall when there is neither enough balance nor a card on file", () => {
    const decision = decideBillingFundingSource({
      amountCents: 2000,
      workspaceConnectEnabled: true,
      availableBalanceCents: 500,
      hasCardOnFile: false,
    });
    expect(decision).toEqual({ source: "blocked", reason: "no_card_on_file", shortfallCents: 1500 });
  });

  it("never charges a non-positive amount", () => {
    expect(
      decideBillingFundingSource({
        amountCents: 0,
        workspaceConnectEnabled: true,
        availableBalanceCents: 0,
        hasCardOnFile: false,
      }),
    ).toEqual({ source: "balance", amountCents: 0 });
  });
});

describe("decideAutoPayoutSwitchRequiresConfirmation (C189)", () => {
  it("never requires confirmation while the flag is off", () => {
    expect(
      decideAutoPayoutSwitchRequiresConfirmation({
        workspaceConnectEnabled: false,
        isExistingWorkspaceOnAutomaticPayouts: true,
        alreadyConfirmed: false,
      }),
    ).toBe(false);
  });

  it("a brand-new workspace never needs confirmation — it was never on automatic payouts", () => {
    expect(
      decideAutoPayoutSwitchRequiresConfirmation({
        workspaceConnectEnabled: true,
        isExistingWorkspaceOnAutomaticPayouts: false,
        alreadyConfirmed: false,
      }),
    ).toBe(false);
  });

  it("an existing workspace on automatic payouts requires the one-time confirm", () => {
    expect(
      decideAutoPayoutSwitchRequiresConfirmation({
        workspaceConnectEnabled: true,
        isExistingWorkspaceOnAutomaticPayouts: true,
        alreadyConfirmed: false,
      }),
    ).toBe(true);
  });

  it("stops asking once already confirmed", () => {
    expect(
      decideAutoPayoutSwitchRequiresConfirmation({
        workspaceConnectEnabled: true,
        isExistingWorkspaceOnAutomaticPayouts: true,
        alreadyConfirmed: true,
      }),
    ).toBe(false);
  });
});

describe("nextWorkspacePayoutMode", () => {
  it("a brand-new workspace starts manual outright", () => {
    expect(
      nextWorkspacePayoutMode({ isExistingWorkspaceOnAutomaticPayouts: false, switchConfirmed: false }),
    ).toBe("manual");
  });

  it("an existing workspace stays automatic until its owner confirms", () => {
    expect(
      nextWorkspacePayoutMode({ isExistingWorkspaceOnAutomaticPayouts: true, switchConfirmed: false }),
    ).toBe("automatic");
  });

  it("an existing workspace switches to manual once confirmed", () => {
    expect(
      nextWorkspacePayoutMode({ isExistingWorkspaceOnAutomaticPayouts: true, switchConfirmed: true }),
    ).toBe("manual");
  });
});
