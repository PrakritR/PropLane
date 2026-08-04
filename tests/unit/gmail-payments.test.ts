import { describe, expect, it } from "vitest";

import {
  formatGmailPaymentsConnectError,
  isGmailPaymentsOAuthBlocked,
} from "@/lib/gmail-payments/connect-errors";
import { buildPaymentReceiptGmailQuery } from "@/lib/gmail-payments/gmail-query";
import { normalizeGmailPaymentsConnection } from "@/lib/gmail-payments/settings";
import { isValidZelleContact } from "@/lib/manager-manual-payment-settings";

describe("buildPaymentReceiptGmailQuery", () => {
  it("includes venmo and zelle senders with day window", () => {
    const q = buildPaymentReceiptGmailQuery(14);
    expect(q).toContain("newer_than:14d");
    expect(q).toContain("venmo.com");
    expect(q).toContain("zellepay.com");
    expect(q).toContain("chase.com");
    expect(q).toContain('subject:"paid you"');
  });

  it("clamps days between 1 and 90", () => {
    expect(buildPaymentReceiptGmailQuery(0)).toContain("newer_than:1d");
    expect(buildPaymentReceiptGmailQuery(200)).toContain("newer_than:90d");
  });
});

describe("formatGmailPaymentsConnectError", () => {
  it("explains Google blocked access and points to forwarding", () => {
    const msg = formatGmailPaymentsConnectError("access_denied");
    expect(msg).toContain("Google blocked Gmail access");
    expect(msg).toContain("Step 4");
  });

  it("detects blocked OAuth reasons", () => {
    expect(isGmailPaymentsOAuthBlocked("This%20app%20is%20blocked")).toBe(true);
    expect(isGmailPaymentsOAuthBlocked("network error")).toBe(false);
  });
});

describe("normalizeGmailPaymentsConnection", () => {
  it("requires refresh token when connected", () => {
    expect(
      normalizeGmailPaymentsConnection({ connected: true, refreshToken: "rtok" }).connected,
    ).toBe(true);
    expect(normalizeGmailPaymentsConnection({ connected: true }).connected).toBe(false);
  });
});

describe("isValidZelleContact", () => {
  it("accepts a Zelle phone number or email but rejects a handle", () => {
    expect(isValidZelleContact("+12065550123")).toBe(true);
    expect(isValidZelleContact("payments@example.com")).toBe(true);
    expect(isValidZelleContact("@not-a-zelle-contact")).toBe(false);
  });
});
