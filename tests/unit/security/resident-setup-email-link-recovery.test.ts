import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Approved residents are provisioned with a random password nobody knows, so the
 * setup form's 401 ("enter the same password you use for that account") is a
 * dead end unless the page offers the email-proof recovery flow. Recovery is
 * only ever a link to the inbox owner — never a password set from this page.
 */
describe("resident setup recovery", () => {
  const CLIENT = readFileSync("src/app/auth/resident-setup/resident-setup-client.tsx", "utf8");

  it("offers an email link when the existing account's password cannot be known", () => {
    expect(CLIENT).toMatch(/res\.status === 401/);
    expect(CLIENT).toContain("emailLinkRecovery");
    expect(CLIENT).toContain("Email me a link");
    expect(CLIENT).toMatch(/\/auth\/forgot-password\?email=\$\{encodeURIComponent\(email\)\}/);
  });

  it("never mints a credential or confirmation from the setup page itself", () => {
    expect(CLIENT).not.toMatch(/confirm-resident-email|email_confirm|updateUserById/);
  });

  it("prefills the reset form from the query so the link goes to that same address", () => {
    const FORGOT = readFileSync("src/app/auth/forgot-password/page.tsx", "utf8");
    expect(FORGOT).toMatch(/searchParams\.get\("email"\)/);
    expect(FORGOT).toContain("requestPasswordReset");
    expect(FORGOT).toContain("Suspense");
  });
});
