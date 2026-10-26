import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { routeResolves } from "../helpers/route-resolves";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ assertTestWorkspaceProviderEffectAllowed: async () => undefined }));

import { connectBusinessProfile, createAxisConnectAccount } from "@/lib/stripe-connect";
import { ensureManagerConnectAccountId } from "@/lib/stripe-connect-account";
import { submitIdentity } from "@/lib/stripe-connect-identity.server";
import {
  VENDOR_INVOICE_PAY_RETURN_PATH,
  vendorBankNotConnectedLine,
  vendorReadyForInvoicePayout,
} from "@/lib/vendor-invoice-pay-readiness";

function stripeStub() {
  return {
    accounts: {
      create: vi.fn().mockResolvedValue({ id: "acct_new" }),
      update: vi.fn().mockResolvedValue({}),
      retrieve: vi.fn().mockResolvedValue({ id: "acct_old" }),
    },
  };
}

describe("P4 account creation", () => {
  it("accounts.create gets an idempotency key derived from the user id", async () => {
    const stripe = stripeStub();
    await createAxisConnectAccount(stripe as never, { axisUserId: "u1", axisPortal: "vendor" });
    await createAxisConnectAccount(stripe as never, { axisUserId: "u1", axisPortal: "vendor" });
    const keys = stripe.accounts.create.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys[0]).toBe("connect-account:vendor:u1");
    expect(keys[1]).toBe(keys[0]);
  });

  it("a relink gets a fresh key so it is not handed the abandoned account", async () => {
    const stripe = stripeStub();
    await createAxisConnectAccount(stripe as never, { axisUserId: "u1", axisPortal: "vendor", idempotencySuffix: "acct_old" });
    expect(stripe.accounts.create.mock.calls[0]![1].idempotencyKey).toBe("connect-account:vendor:u1:acct_old");
  });

  it("vendor accounts carry MCC 1799; manager accounts are unchanged", async () => {
    const stripe = stripeStub();
    await createAxisConnectAccount(stripe as never, { axisUserId: "v", axisPortal: "vendor" });
    await createAxisConnectAccount(stripe as never, { axisUserId: "m", axisPortal: "portal" });
    expect(stripe.accounts.create.mock.calls[0]![0].business_profile).toEqual({
      mcc: "1799",
      product_description: "Home repair and maintenance services",
    });
    expect(stripe.accounts.create.mock.calls[1]![0].business_profile).toBeUndefined();
    expect(connectBusinessProfile("portal")).toEqual({ mcc: "6513", product_description: "Property management services" });
  });

  it("identity submit: vendor 1799, manager 6513", async () => {
    for (const [portal, mcc] of [["vendor", "1799"], ["portal", "6513"], [undefined, "6513"]] as const) {
      const stripe = stripeStub();
      stripe.accounts.retrieve.mockResolvedValue({ id: "acct_1", requirements: { currently_due: [], past_due: [], pending_verification: [] }, details_submitted: true });
      await submitIdentity(stripe as never, "acct_1", {
        portal,
        fields: {},
        tosAcceptance: { date: 1700000000, ip: "203.0.113.5", userAgent: "vitest" },
      } as never);
      const update = stripe.accounts.update.mock.calls.find((c) => c[1]?.business_profile);
      expect(update![1].business_profile.mcc).toBe(mcc);
    }
  });

  it("does not create when an account id already exists, nor when a concurrent request just saved one", async () => {
    const stripe = stripeStub();
    const profile = (ids: Array<string | null>) => {
      let n = 0;
      return {
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { stripe_connect_account_id: ids[Math.min(n++, ids.length - 1)] } }) }) }) }),
      };
    };
    expect(await ensureManagerConnectAccountId(stripe as never, profile(["acct_old"]) as never, { userId: "u1" })).toBe("acct_old");
    expect(await ensureManagerConnectAccountId(stripe as never, profile([null, "acct_race"]) as never, { userId: "u1", axisPortal: "vendor" })).toBe("acct_race");
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });
});

describe("P2 vendor readiness warning", () => {
  it("ready = transfers active AND payouts enabled", () => {
    expect(vendorReadyForInvoicePayout({ payouts_enabled: true, capabilities: { transfers: "active" } })).toBe(true);
    expect(vendorReadyForInvoicePayout({ payouts_enabled: true, capabilities: { transfers: "pending" } })).toBe(false);
    expect(vendorReadyForInvoicePayout({ payouts_enabled: false, capabilities: { transfers: "active" } })).toBe(false);
    expect(vendorReadyForInvoicePayout(null)).toBe(false);
  });

  it("the one warning line shows only when the vendor is known not ready", () => {
    expect(vendorBankNotConnectedLine("Acme Plumbing", false)).toBe(
      "Acme Plumbing hasn't connected a bank yet. You're charged now; they're paid when they connect.",
    );
    expect(vendorBankNotConnectedLine("Acme Plumbing", true)).toBeNull();
    expect(vendorBankNotConnectedLine("Acme Plumbing", undefined)).toBeNull();
  });

  it("the sheet renders that line and the readiness rides the outgoing GET", () => {
    const sheet = readFileSync("src/components/portal/vendor-invoice-manager-pay-sheet.tsx", "utf8");
    expect(sheet).toContain("vendorBankNotConnectedLine(");
    expect(sheet).toContain('data-attr="vendor-invoice-pay-bank-warning"');
    expect(readFileSync("src/app/api/vendor/invoices/[id]/outgoing/route.ts", "utf8")).toContain("vendorPayoutsReady");
  });
});

describe("P3 return URL", () => {
  it("resolves against src/app with no portal redirect on the way", () => {
    expect(VENDOR_INVOICE_PAY_RETURN_PATH).toBe("/portal/outgoing/paid");
    expect(routeResolves(VENDOR_INVOICE_PAY_RETURN_PATH)).toBe(true);
    const render = readFileSync("src/lib/render-portal-section.tsx", "utf8");
    expect(render).toContain('["to-pay", "scheduled", "paid"].includes(outgoingTab)');
  });

  it("the pay server builds the return URL from that path and finishes in place for cards", () => {
    const src = readFileSync("src/lib/vendor-invoice-pay.server.ts", "utf8");
    expect(src).toContain("${VENDOR_INVOICE_PAY_RETURN_PATH}?invoice_pay=success");
    expect(src).toContain('redirectOnCompletion: "if_required"');
    expect(src).not.toContain("/portal/finances?invoice_pay");
  });
});
