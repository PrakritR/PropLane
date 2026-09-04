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
const resolver = readFileSync("src/lib/auth/resolve-oauth-portal-access.ts", "utf8");

describe("the signup role survives Google sign-in", () => {
  it("the auth form sends the URL role as the OAuth intent", () => {
    expect(form).toContain("intent={prospectHandoff ? \"resident\" : pickerRoleFromParam(roleFromUrl)}");
  });

  it("only the three real portal ids can become an intent", () => {
    // `?role=` is user-supplied; pickerRoleFromParam is the allowlist.
    expect(form).toContain("function pickerRoleFromParam");
    expect(form).toContain("AUTH_PORTAL_PICKER_OPTIONS.some((opt) => opt.id === value)");
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
