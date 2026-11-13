import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountHolderNameFromAccount, holderNamesMatch } from "@/lib/stripe-account-holder";

const read = (p: string) => readFileSync(p, "utf8");

describe("account holder lock", () => {
  it("reads the verified individual or company name", () => {
    expect(accountHolderNameFromAccount({ individual: { first_name: "Ambika", last_name: "Rao" } } as never)).toBe("Ambika Rao");
    expect(accountHolderNameFromAccount({ company: { name: "Rao LLC" } } as never)).toBe("Rao LLC");
    expect(accountHolderNameFromAccount({} as never)).toBeNull();
  });
  it("matches ignoring order and punctuation, refuses another person", () => {
    expect(holderNamesMatch("Rao, Ambika", "Ambika Rao")).toBe(true);
    expect(holderNamesMatch("Someone Else", "Ambika Rao")).toBe(false);
    expect(holderNamesMatch("", "")).toBe(false);
  });
  it("the server checks the bank token's holder name against the Stripe account before attaching it", () => {
    const src = read("src/lib/stripe-external-accounts.server.ts");
    expect(src).toContain("holderNamesMatch(tokenName, holder)");
    expect(src.indexOf("holderNamesMatch(tokenName")).toBeLessThan(src.indexOf("createExternalAccount(accountId"));
  });
  it("the bank sheet's holder field is read-only", () => {
    expect(read("src/components/portal/payout-bank-sheet.tsx")).toContain("readOnly");
  });
});

describe("staff never set up payouts as the owner", () => {
  it("resolveStripePayoutContext refuses staff in a managed workspace before resolving their own account", () => {
    const src = read("src/lib/auth/manager-stripe-payout-access.server.ts");
    expect(src).toContain("staff_managed_workspace");
    expect(src.indexOf("resolveManagedPayoutStaffContext(db")).toBeLessThan(src.indexOf("userOwnsManagerProperties(db, uid)"));
  });
  it("every payout route maps the refusal to 403, not a generic 500", () => {
    for (const f of ["account-session", "onboard", "identity", "status", "bank-accounts"]) {
      expect(read(`src/app/api/stripe/connect/${f}/route.ts`)).toContain("stripePayoutContextStatus");
    }
  });
  it("the payee is resolved through the one helper, never the workspace owner", () => {
    expect(read("src/lib/managed-finance/payout-setup.server.ts")).toContain("resolveManagedPayee(db, ws)");
    expect(read("src/lib/managed-finance/payee.server.ts")).not.toMatch(/portal_workspaces/);
  });
  it("the send-link recipient is derived from the workspace, never the body", () => {
    const src = read("src/app/api/portal/managed-payout-status/send-link/route.ts");
    expect(src).toContain("ctx.ownerUserId");
    expect(src).not.toMatch(/body\??\.(ownerUserId|email|to)/);
  });
  it("Stripe's real error is returned, not a generic screen", () => {
    const src = read("src/lib/stripe-payouts.server.ts");
    expect(src).toContain('stripeType.startsWith("Stripe")');
    expect(src).toContain("CONNECT_ACCOUNT_NOT_EMBEDDABLE");
  });
});
