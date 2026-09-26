import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Night flow: /auth/create-account?mode=create&role=resident hung on
 * "Creating…" forever, with no error and no way forward, when the email
 * already had an account with a DIFFERENT password than the one just typed.
 *
 * Root cause: the create-account submit in portal-auth-form.tsx already
 * wraps the POST-CREATE sign-in retry in this file's own withTimeout (see
 * SIGNUP_SIGNIN_TIMEOUT_MS), but the FIRST call — POST /api/auth/signup,
 * which for an existing email routes through a live Supabase password check
 * (assertPasswordMatchesExistingAuthUser) — had no ceiling at all. If that
 * check ever stalled, `busy` stayed true forever: the `finally` that clears
 * it only runs once the awaited promise settles.
 *
 * Same convention as signup-sign-in-timeout.test.ts, which guards the
 * sibling *-signup-form.tsx/*-signup-panel.tsx files the same way — this
 * file predates and does not match that glob, so it needed its own check.
 */
const source = readFileSync(
  join(process.cwd(), "src/components/auth/portal-auth-form.tsx"),
  "utf8",
);

describe("portal-auth-form.tsx create-account signup call is bounded", () => {
  it("wraps the /api/auth/signup fetch in withTimeout, not a bare await", () => {
    expect(source).toContain("SIGNUP_CREATE_TIMEOUT_MS");
    expect(source).toMatch(/withTimeout\(\s*fetch\("\/api\/auth\/signup"/);
    // Not a bare, unbounded await of that fetch.
    expect(source).not.toMatch(/const res = await fetch\("\/api\/auth\/signup"/);
  });

  it("shows the honest existing-account message with a real Sign in link, not a dead end", () => {
    expect(source).toContain("EXISTING_ACCOUNT_PASSWORD_MISMATCH");
    expect(source).toMatch(/errorText === EXISTING_ACCOUNT_PASSWORD_MISMATCH/);
    expect(source).toContain("portal-auth-existing-account-sign-in");
  });
});
