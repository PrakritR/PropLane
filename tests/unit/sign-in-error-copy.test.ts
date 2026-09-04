import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { authErrorOffersAccountRoutes } from "@/components/auth/portal-auth-form";

/**
 * Signing in with an email that has NO account returned Supabase's raw
 * "Invalid login credentials" — the same string a wrong password gives, in
 * provider language, routing nowhere (PRP-189). During QA the only way to
 * establish which it was was to query the database.
 */
const SOURCE = readFileSync(
  join(process.cwd(), "src/components/auth/portal-auth-form.tsx"),
  "utf8",
);

describe("sign-in failure copy", () => {
  it("no longer shows the provider's string", () => {
    const fn = SOURCE.slice(SOURCE.indexOf("function friendlyAuthError("), SOURCE.indexOf("/** Whether the failure"));
    expect(fn).toContain('lower.includes("invalid login credentials")');
    expect(fn).toContain("don't match an account");
  });

  it("stays ambiguous between a wrong password and no account", () => {
    // Distinguishing them would make this form an account-existence oracle —
    // the exact property POST /api/auth/password-reset answers {ok:true} for
    // unknown addresses to avoid.
    const fn = SOURCE.slice(SOURCE.indexOf("function friendlyAuthError("), SOURCE.indexOf("/** Whether the failure"));
    expect(fn).not.toMatch(/no account (exists|found)|account does not exist|not registered/i);
  });

  it("offers both ways forward from the error itself", () => {
    expect(authErrorOffersAccountRoutes("That email and password don't match an account. Check the password, or create an account if you don't have one yet.")).toBe(true);
    expect(SOURCE).toContain('href="/auth/forgot-password"');
    expect(SOURCE).toContain("href={GET_STARTED_PATH}");
  });

  it("does not attach those links to unrelated failures", () => {
    expect(authErrorOffersAccountRoutes("We could not reach PropLane. Please check your connection and try again.")).toBe(false);
    expect(authErrorOffersAccountRoutes(null)).toBe(false);
  });

  it("also translates the unconfirmed-email case", () => {
    expect(SOURCE).toContain("hasn't been confirmed yet");
  });
});
