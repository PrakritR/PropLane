import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { presentSignInError } from "@/lib/auth/sign-in-error";

/**
 * Signing in with an email that has NO account returned Supabase's raw
 * "Invalid login credentials" — the same string a wrong password gives, in
 * provider language, routing nowhere (PRP-189). During QA the only way to
 * establish which it was was to query the database.
 *
 * This used to assert against portal-auth-form.tsx. That file no longer serves
 * sign-in (NativeAuthHub does), so the copy it was guarding had become
 * unreachable and the shipping copy was covered by nothing.
 */
const NOTICE = readFileSync(
  join(process.cwd(), "src/components/auth/sign-in-error-notice.tsx"),
  "utf8",
);
const HUB = readFileSync(
  join(process.cwd(), "src/components/auth/native-auth-hub.tsx"),
  "utf8",
);

describe("sign-in failure copy", () => {
  it("no longer shows the provider's string", () => {
    const presented = presentSignInError("Invalid login credentials");
    expect(presented.message).not.toMatch(/invalid login credentials/i);
    expect(presented.message).toContain("do not match an account");
    expect(presented.credentialMismatch).toBe(true);
  });

  it("stays ambiguous between a wrong password and no account", () => {
    // Distinguishing them would make this form an account-existence oracle —
    // the exact property POST /api/auth/password-reset answers {ok:true} for
    // unknown addresses to avoid.
    expect(presentSignInError("Invalid login credentials").message).not.toMatch(
      /no account (exists|found)|account does not exist|not registered/i,
    );
  });

  it("offers both ways forward from the error itself", () => {
    expect(NOTICE).toContain('href="/auth/forgot-password"');
    expect(NOTICE).toContain("href={createAccountHref}");
    // Both only render for the mismatch case, and the hub is what mounts them.
    expect(NOTICE).toContain("error.credentialMismatch");
    expect(HUB).toContain("SignInErrorNotice");
  });

  it("does not attach those links to unrelated failures", () => {
    expect(
      presentSignInError("We could not reach PropLane. Please check your connection and try again.")
        .credentialMismatch,
    ).toBe(false);
    expect(presentSignInError("").credentialMismatch).toBe(false);
  });

  it("also translates the unconfirmed-email case", () => {
    expect(presentSignInError("Email not confirmed").message).toContain("hasn't been confirmed yet");
  });
});
