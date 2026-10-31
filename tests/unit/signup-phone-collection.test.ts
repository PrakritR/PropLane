import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = "src/components/auth/portal-auth-form.tsx";
/** The hub's own fields now live here: one surface, email proof first, then name and phone. */
const HUB = "src/components/auth/email-first-signup.tsx";
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
    // The hub form owns no inputs: it renders `EmailFirstSignup`, whose completion step collects
    // the phone for EVERY intent — there is no longer any condition it could regrow.
    const form = read(FORM);
    expect(form).toContain("<EmailFirstSignup");
    expect(form).not.toContain('type="tel"');

    const hub = read(HUB);
    expect(hub).toContain("<PhoneNumberField");
    // The field sits in the verified-email branch, not behind any per-intent condition.
    const completion = hub.slice(hub.indexOf("Verified email"));
    expect(completion).toContain("<PhoneNumberField");

    // The shared stack still renders phone unconditionally for the forms that use it.
    const stack = read(STACK);
    const phoneIdx = stack.indexOf("<PhoneNumberField");
    expect(phoneIdx).toBeGreaterThan(-1);
    const before = stack.slice(stack.indexOf("return (\n    <>"), phoneIdx);
    expect(before).not.toContain("?");
  });

  it("sends the phone it collected", () => {
    // The state and input existed before; only the payload was missing, which
    // is why the field silently did nothing even when it was shown.
    const hub = read(HUB);
    expect(hub).toContain('endpoint: Record<Intent, string> = { generic: "/api/auth/signup"');
    expect(hub).toContain("phone: phone.trim()");
  });

  it("accepts and normalizes the phone server-side without requiring one", () => {
    const route = read(ROUTE);
    expect(route).toContain("normalizeE164");
    // The number rides on the auth metadata: no profile row exists yet (the role step creates it), and
    // `ensureSignedInResidentAccount` writes the name and number onto it when the role is provisioned.
    expect(route).toContain("phone ? { phone } : {}");
    expect(route).not.toContain('.from("profiles").update');
    // Role-agnostic route: a resident signing up must not be blocked on it.
    expect(route).not.toContain('Enter a valid phone number.');
  });
});

describe("PRP-380: manager signup labels phone as required", () => {
  it("manager-register paths do not say phone is optional", () => {
    const panel = read("src/components/auth/manager-signup-panel.tsx");
    const trial = read("src/components/auth/manager-trial-signup-form.tsx");

    expect(panel).not.toContain("Phone (optional)");
    expect(panel).toContain('placeholder="Phone number"');
    expect(trial).toContain('phonePlaceholder="Phone number"');
    // The third door, `create-account-client.tsx`, is gone: the create-account router renders the
    // email-proof signup and nothing imported that password client. The shared field stack is the
    // one place the hub's phone requirement now lives.
    expect(existsSync(join(process.cwd(), "src/app/auth/create-account/create-account-client.tsx"))).toBe(false);
    expect(read(STACK)).toContain("<PhoneNumberField");
  });
});
