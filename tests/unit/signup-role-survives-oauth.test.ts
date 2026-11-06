/**
 * AXI-126 / AXI-152 — "since I clicked manager/vendor/resident while signing up
 * it should not ask which account I want."
 *
 * The role that got the user here (`?role=manager` from the public nav,
 * `role=resident` from an apply or tour link) has to survive the Google round
 * trip. It did not: the auth form set an OAuth intent ONLY for the prospect
 * handoff, so every other role-carrying entry came back with nothing and the
 * resolver — finding no purchase and no application, because they have not
 * applied yet — sent them to the chooser to answer again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const form = readFileSync("src/components/auth/portal-auth-form.tsx", "utf8");
const emailFirst = readFileSync("src/components/auth/email-first-signup.tsx", "utf8");
const resolver = readFileSync("src/lib/auth/resolve-oauth-portal-access.ts", "utf8");

describe("the signup role survives Google sign-in", () => {
  it("the auth form derives the role from the URL and hands it to the signup surface", () => {
    // The hub no longer owns the OAuth buttons: it resolves the role off `?role=` and passes it to
    // `EmailFirstSignup`, which mounts the social stack. The guarantee is the same — a
    // role-carrying entry must not come back from Google with nothing.
    expect(form).toContain('params.get("role") === "resident"');
    expect(form).toContain("<EmailFirstSignup intent={intent}");
  });

  it("the signup surface sends that role on as the OAuth intent", () => {
    expect(emailFirst).toContain("<OAuthSocialStack");
    expect(emailFirst).toContain('intent={intent === "generic" ? null : intent}');
  });

  it("only a real portal id can become an intent", () => {
    // `?role=` is user-supplied. The hub narrows it to a literal before it travels, and
    // `OAuthSignInIntent` is the type-level allowlist on the receiving end.
    expect(form).not.toMatch(/intent=\{[^}]*params\.get\("role"\)/);
    const stack = readFileSync("src/components/auth/oauth-social-stack.tsx", "utf8");
    expect(stack).toContain("intent?: OAuthSignInIntent | null");
  });

  it("the resolver hands that role to the chooser instead of re-asking", () => {
    const tail = resolver.slice(resolver.indexOf("// Unknown account:"));
    expect(tail).toContain("if (intent) {");
    expect(tail).toContain('new URLSearchParams({ role: intent })');
  });

  it("and keeps the destination through the detour", () => {
    const tail = resolver.slice(resolver.indexOf("// Unknown account:"));
    expect(tail).toContain('params.set("next", safeIntended)');
  });

  it("no intent still means the plain chooser", () => {
    const tail = resolver.slice(resolver.indexOf("// Unknown account:"));
    expect(tail).toContain("return finish(GET_STARTED_PATH);");
  });
});
