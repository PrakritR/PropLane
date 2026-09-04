/**
 * App Review rejected build 1.0 (69) under Guideline 2.1(a): "We received an
 * error message after we attempted to log in", on an iPad Air 11-inch running
 * iPadOS 26.6.
 *
 * The sign-in screen had no `<form>` and no named fields — two loose `<Input>`s
 * in a `<div>` behind a `type="button"`. iOS/iPadOS Password AutoFill writes
 * straight into an input's DOM value, and WebKit does not reliably deliver that
 * to React as a change event, so the boxes visibly held the credentials while
 * the component's state was still empty. `signIn` read state, found nothing,
 * and refused with "Enter email and password." over credentials the reviewer
 * could plainly see. Chrome flags the same markup: "Password field is not
 * contained in a form" and "A form field element should have an id or name".
 *
 * Both halves of the fix are load-bearing and this pins both: a real named form
 * (so AutoFill and password managers can identify the fields at all, and so the
 * iOS keyboard offers "Go" and submits), and a DOM read at submit time (so a
 * value that never reached React state still signs the user in).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFormCredentials } from "@/lib/auth/form-credentials";

const REPO_ROOT = path.resolve(__dirname, "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const SIGN_IN = "src/components/auth/native-auth-hub.tsx";

describe("sign-in credential fields", () => {
  const src = source(SIGN_IN);

  it("wraps the credentials in a real form that submits", () => {
    expect(src).toMatch(/<form\b/);
    expect(src).toMatch(/onSubmit=\{/);
    // The submit must be the form's, not an onClick on a plain button —
    // otherwise the iOS keyboard's Go key still does nothing.
    expect(src).toMatch(/type="submit"/);
  });

  it("names both fields so AutoFill can identify them", () => {
    expect(src).toMatch(/name="email"/);
    expect(src).toMatch(/name="password"/);
    expect(src).toMatch(/id="auth-hub-email"/);
    expect(src).toMatch(/id="auth-hub-password"/);
    expect(src).toMatch(/autoComplete="email"/);
    expect(src).toMatch(/autoComplete="current-password"/);
  });

  it("reads the DOM at submit time, not component state alone", () => {
    expect(src).toMatch(/credentialsFromDom/);
    // The refusal must be judged on the resolved credentials. Testing the raw
    // state again here is exactly the bug App Review hit.
    expect(src).toMatch(/if \(!credentials\.email \|\| !credentials\.password\)/);
    expect(src).not.toMatch(/if \(!email\.trim\(\) \|\| !password\) \{/);
  });

  it("signs in with the resolved credentials, never the possibly-empty state", () => {
    // The address may be wrapped in `normalizeAuthEmail` (PRP-196: a capital
    // first letter from a mobile keyboard is a different account to the auth
    // provider) — what must not change is that it comes from `credentials`,
    // the DOM read, and not from React state AutoFill never reached.
    const signInCall =
      /signInWithPassword\(\{\s*email: (?:normalizeAuthEmail\()?credentials\.email\)?,\s*password: credentials\.password,?\s*\}\)/;
    expect(src).toMatch(signInCall);
    expect(src).not.toMatch(/signInWithPassword\(\{\s*email: (?:normalizeAuthEmail\()?email/);
  });
});

describe("resolveFormCredentials", () => {
  it("takes both fields from the DOM when AutoFill never reached React state", () => {
    expect(
      resolveFormCredentials({
        domEmail: " reviewer@example.com ",
        domPassword: "autofilled-secret",
        stateEmail: "",
        statePassword: "",
      }),
    ).toEqual({ email: "reviewer@example.com", password: "autofilled-secret" });
  });

  it("keeps the AutoFilled pair together over a remembered email in state", () => {
    // The returning-user path: `readRememberedLoginEmail` seeds account A into
    // state, then AutoFill picks account B. Submitting A's email with B's
    // password is a pair the person was never shown.
    expect(
      resolveFormCredentials({
        domEmail: "accountB@example.com",
        domPassword: "b-password",
        stateEmail: "accountA@example.com",
        statePassword: "",
      }),
    ).toEqual({ email: "accountB@example.com", password: "b-password" });
  });

  it("falls back to state when the DOM is unreadable", () => {
    expect(
      resolveFormCredentials({
        domEmail: "",
        domPassword: "",
        stateEmail: " typed@example.com ",
        statePassword: "typed-password",
      }),
    ).toEqual({ email: "typed@example.com", password: "typed-password" });
  });

  it("does not treat a whitespace-only DOM email as an entry", () => {
    expect(
      resolveFormCredentials({
        domEmail: "   ",
        domPassword: "",
        stateEmail: "typed@example.com",
        statePassword: "typed-password",
      }),
    ).toEqual({ email: "typed@example.com", password: "typed-password" });
  });
});

/**
 * Every other password-entry surface still has the original shape. They are NOT
 * on the rejected login path — App Review's note is about logging in — but the
 * same AutoFill failure is reachable from each, so this is a known-violation
 * list to shrink, never a place to add a new entry.
 *
 * Delete a path from here when it gets a named form; the test fails if one is
 * listed but already fixed, so the list cannot silently rot.
 */
const KNOWN_UNCONVERTED_CREDENTIAL_SURFACES = [
  "src/components/auth/vendor-signup-form.tsx",
  "src/components/auth/resident-signup-form.tsx",
  "src/components/auth/manager-signup-panel.tsx",
  "src/components/auth/manager-trial-signup-form.tsx",
  "src/components/auth/portal-auth-form.tsx",
  "src/app/auth/resident-setup/resident-setup-client.tsx",
  "src/app/auth/create-account/create-account-client.tsx",
  "src/app/auth/reset-password/page.tsx",
];

describe("remaining credential surfaces", () => {
  it.each(KNOWN_UNCONVERTED_CREDENTIAL_SURFACES)("%s is still on the list", (relativePath) => {
    const src = source(relativePath);
    const converted = /<form\b/.test(src) && /name="password"/.test(src);
    expect(
      converted,
      `${relativePath} now uses a named form — remove it from KNOWN_UNCONVERTED_CREDENTIAL_SURFACES.`,
    ).toBe(false);
  });
});
