import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This file used to pin a bounded `/api/auth/signup` POST and the existing-account copy INSIDE
 * `LegacyPortalAuthForm` — the hub's password create-account form.
 *
 * That flow is retired. `/api/auth/signup` no longer creates anything: it refuses every caller
 * that is not already a verified, signed-in mailbox owner, so there is no live password check for a
 * timeout to bound and no "that email already has an account with a different password" branch to
 * route out of. `LegacyPortalAuthForm` had been unreachable since `PortalAuthForm` stopped
 * branching, and it is now deleted.
 *
 * So the guarantee this file keeps is the RETIREMENT, which is the stronger one: the hub has no
 * password at all, and the mailbox is proven by an emailed `token_hash` link before any account
 * detail is collected. A re-grown password path fails here.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/**
 * The password scan looks at CODE, not prose: the comment that records the retirement names the
 * deleted `signInWithPassword` call on purpose, and a guard that cannot tell the two apart would
 * force that history out of the file it documents.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const form = read("src/components/auth/portal-auth-form.tsx");
const emailFirst = read("src/components/auth/email-first-signup.tsx");

describe("the create-account hub has no password signup to hang on", () => {
  it("renders the email-first signup and nothing else", () => {
    expect(form).toContain("<EmailFirstSignup");
    // The function itself is gone. (Its name survives in the comment that records the deletion.)
    expect(form).not.toMatch(/function LegacyPortalAuthForm/);
  });

  it("collects no password and never signs in with one", () => {
    for (const source of [withoutComments(form), withoutComments(emailFirst)]) {
      expect(source).not.toContain("signInWithPassword");
      expect(source).not.toMatch(/type="password"/);
      expect(source).not.toContain("new-password");
    }
  });

  it("proves the mailbox with an emailed link before any account detail", () => {
    // The unverified branch starts the emailed-link handoff; only a verified session reaches the
    // completion endpoints that write anything.
    expect(emailFirst).toContain('"/api/auth/email-onboarding/start"');
    expect(emailFirst).toContain("verifiedEmail ? endpoint[intent] : \"/api/auth/email-onboarding/start\"");
  });

  it("keeps /api/auth/signup refusing anyone who has not proven their mailbox", () => {
    const route = read("src/app/api/auth/signup/route.ts");
    expect(route).toContain("EMAIL_VERIFICATION_REQUIRED");
    expect(route).toContain("email_confirmed_at");
    // It cannot mint or confirm an account, and it takes no password.
    expect(route).not.toContain("createUser(");
    expect(route).not.toContain("password");
  });

  it("the deleted password client stays deleted", () => {
    expect(existsSync(join(process.cwd(), "src/app/auth/create-account/create-account-client.tsx"))).toBe(false);
  });
});
