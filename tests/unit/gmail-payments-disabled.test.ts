/**
 * PRP-130 — "google hasn't verified the app", and the captain's call: drop Gmail
 * for now, Zelle/Venmo get recorded by hand.
 *
 * The integration was never broken. Google shows its unverified-app interstitial
 * because PropLane requests `gmail.readonly`, which Google classes RESTRICTED —
 * verification PLUS an annual third-party security assessment. `calendar.events`
 * is merely sensitive: ordinary verification, no assessment. So the fix is to
 * stop requesting the one restricted scope.
 *
 * Everything behind the flag is left INTACT — the sync, the parsers, the stored
 * connections — so this is one constant to reverse, not a feature to rebuild.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GMAIL_PAYMENTS_ENABLED } from "@/lib/gmail-payments/enabled";

const read = (p: string) => readFileSync(p, "utf8");

describe("Gmail payment receipts are off", () => {
  it("the flag is off, in exactly one place", () => {
    expect(GMAIL_PAYMENTS_ENABLED).toBe(false);
  });

  it("neither connect route can redirect to Google while it is off", () => {
    // This is the ONLY place the restricted scope would be requested, so the
    // guard belongs here rather than anywhere downstream.
    for (const route of [
      "src/app/api/portal/gmail-payments/connect/route.ts",
      "src/app/api/vendor/gmail-payments/connect/route.ts",
    ]) {
      const src = read(route);
      expect(src).toContain("if (!GMAIL_PAYMENTS_ENABLED)");
      // …and the refusal comes BEFORE the OAuth URL is ever built (the call,
      // not the import at the top of the file).
      expect(src.indexOf("if (!GMAIL_PAYMENTS_ENABLED)")).toBeLessThan(
        src.indexOf("= buildGmailPaymentsOAuthUrl("),
      );
    }
  });

  it("no UI offers a connection that would be refused", () => {
    expect(read("src/app/auth/manager/connect-google/page.tsx")).toContain(
      "{GMAIL_PAYMENTS_ENABLED ? (",
    );
    expect(read("src/components/portal/pro-payment-setup-modal.tsx")).toContain(
      'GMAIL_PAYMENTS_ENABLED ? "" : "hidden"',
    );
    // The signup step's Gmail card was already removed outright.
    expect(read("src/app/auth/connect-google-services/page.tsx")).not.toContain(
      "gmail-payments/connect",
    );
  });

  it("the nightly sync stops rather than failing every stored connection one by one", () => {
    expect(read("src/app/api/cron/sync-manual-payments/route.ts")).toContain(
      'skipped: "gmail_payments_disabled"',
    );
  });

  it("Calendar is untouched — it is the scope that does NOT need an assessment", () => {
    const scopes = read("src/lib/google-calendar/scopes.ts");
    expect(scopes).toContain("auth/calendar.events");
    expect(scopes).not.toContain("gmail");
  });
});
