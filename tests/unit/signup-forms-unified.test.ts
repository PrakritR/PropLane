import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Resident, vendor and manager signup are ONE form wearing three hats.
 *
 * They were ~1,100 lines of near-duplicate: each had its own field markup, each
 * had two competing layouts behind a `variant` prop, and they had drifted in
 * substance — vendor asked only for email and password, so a vendor account was
 * created with no name and no number for dispatch to reach.
 *
 * These assertions are structural on purpose. Nothing about a divergent copy
 * fails a build or a render test; it just quietly asks different questions.
 */
const read = (f: string) => readFileSync(join(process.cwd(), "src/components/auth", f), "utf8");

const FORMS = [
  "resident-signup-form.tsx",
  "vendor-signup-form.tsx",
  "manager-trial-signup-form.tsx",
] as const;

describe("the three signup forms share one field definition", () => {
  it("every form renders SignupFieldStack", () => {
    for (const form of FORMS) {
      expect(read(form), form).toContain("<SignupFieldStack");
    }
  });

  it("no form hand-rolls its own account fields any more", () => {
    for (const form of FORMS) {
      const src = read(form);
      // The four account fields must come from the shared stack, so a fix
      // applied to one cannot be missing from another.
      expect(src, form).not.toContain('placeholder="Full name"');
      expect(src, form).not.toContain('placeholder="Password (8+ characters)"');
    }
  });

  it("vendor collects a name and phone, like the other two", () => {
    const vendor = read("vendor-signup-form.tsx");
    expect(vendor).toContain("fullName");
    expect(vendor).toContain("phone");
  });

  it("the shared stack keeps the iOS autocapitalise guard (PRP-196)", () => {
    // Manager@… and manager@… were becoming different accounts. Losing this
    // breaks sign-in for anyone typing on a phone, and nothing else catches it.
    const stack = read("signup-field-stack.tsx");
    expect(stack).toContain('autoCapitalize="none"');
    expect(stack).toContain("autoCorrect=");
  });
});

describe("the vendor register route accepts what its form now collects", () => {
  it("takes a phone, so the field cannot silently discard input", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/auth/vendor-register/route.ts"),
      "utf8",
    );
    expect(route).toContain("phone?: string;");
    expect(route).toContain("normalizeE164");
    // Applied on ALL success paths: invite, self-serve existing, self-serve new.
    expect(route.match(/await applyVendorPhone\(/g)?.length ?? 0).toBe(3);
  });

  it("the create-account hub form is create-only — no second field copy", () => {
    const form = readFileSync(join(process.cwd(), "src/components/auth/portal-auth-form.tsx"), "utf8");
    // It served sign-in too, behind mode/variant props no caller passed, and
    // carried a whole second set of inputs for the unreachable layout. That
    // copy had already drifted (it never grew the phone field), which is the
    // failure mode this whole unification exists to prevent.
    expect(form).toContain("<SignupFieldStack");
    expect(form).not.toContain("labeledFields");
    expect(form).not.toContain("isCreate");
    expect(form).not.toContain("handleSignIn");
    expect(form).not.toMatch(/mode\s*:\s*"sign-in"/);
    expect(
      readFileSync(join(process.cwd(), "src/app/auth/create-account/create-account-role-gateway.tsx"), "utf8"),
    ).toContain(
      "<PortalAuthForm />",
    );
  });
});
