import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = "src/components/auth/portal-auth-form.tsx";
const STACK = "src/components/auth/signup-field-stack.tsx";
const ROUTE = "src/app/api/auth/signup/route.ts";

/**
 * PRP-186. There are two manager signup doors:
 *
 *   /auth/create-account?role=manager -> ManagerTrialSignupForm (phone REQUIRED)
 *   /auth/create-account              -> PortalAuthForm hub, role picked after
 *
 * The second one rendered its phone input only for a prospect handoff, and the
 * submit payload dropped `phone` entirely — so a manager who arrived by that
 * door had no number on file, and inbound SMS identity (which binds a sender to
 * the owner's verified cell) had nothing to match. PRP-174 closed the first
 * door; this covers the second.
 */
describe("PRP-186: the hub signup form collects a phone", () => {
  it("renders the input for any create, not just a prospect handoff", () => {
    // The fields moved into the one shared stack, so the guarantee is now that
    // the hub form renders that stack and the stack renders phone
    // UNCONDITIONALLY — there is no longer any condition it could regrow.
    const form = read(FORM);
    expect(form).toContain("<SignupFieldStack");
    expect(form).not.toContain('type="tel"');

    const stack = read(STACK);
    const telIdx = stack.indexOf('type="tel"');
    expect(telIdx).toBeGreaterThan(-1);
    // Nothing between the fragment open and the phone input may branch on it.
    const before = stack.slice(stack.indexOf("return (\n    <>"), telIdx);
    expect(before).not.toContain("?");
  });

  it("sends the phone it collected", () => {
    // The state and input existed before; only the payload was missing, which
    // is why the field silently did nothing even when it was shown.
    const form = read(FORM);
    const signupCall = form.slice(form.indexOf('"/api/auth/signup"'));
    expect(signupCall.slice(0, 500)).toContain("phone:");
  });

  it("accepts and normalizes the phone server-side without requiring one", () => {
    const route = read(ROUTE);
    expect(route).toContain("normalizeE164");
    expect(route).toContain('.from("profiles").update({ phone })');
    // Role-agnostic route: a resident signing up must not be blocked on it.
    expect(route).not.toContain('Enter a valid phone number.');
  });
});
