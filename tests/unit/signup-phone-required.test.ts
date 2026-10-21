// Phone-first accounts: every website sign-up door collects the phone (manager, vendor, resident, the role-agnostic hub).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("website sign-up collects the phone", () => {
  it("manager-register and resident-register refuse a missing phone", () => {
    for (const route of ["src/app/api/auth/manager-register/route.ts", "src/app/api/auth/resident-register/route.ts"]) {
      expect(read(route)).toContain("Enter a valid phone number.");
    }
  });

  it("vendor-register refuses a missing phone for both invite and self-serve, before anything else is read", () => {
    const route = read("src/app/api/auth/vendor-register/route.ts");
    const post = route.slice(route.indexOf("export async function POST"));
    expect(post.indexOf("Enter a valid phone number.")).toBeGreaterThan(-1);
    expect(post.indexOf("Enter a valid phone number.")).toBeLessThan(post.indexOf("registerFromInvite"));
    expect(route).not.toContain("Optional for a vendor");
  });

  it("the vendor, resident and hub forms mark the phone required and check it before posting", () => {
    expect(read("src/components/auth/vendor-signup-form.tsx")).toMatch(/phoneRequired/);
    expect(read("src/components/auth/vendor-signup-form.tsx")).toContain('setError("Enter a valid phone number.")');
    expect(read("src/components/auth/resident-signup-form.tsx")).toMatch(/phoneRequired/);
    expect(read("src/components/auth/portal-auth-form.tsx")).toMatch(/phoneRequired/);
    expect(read("src/components/auth/portal-auth-form.tsx")).toContain('setErrorText("Enter a valid phone number.")');
    expect(read("src/components/auth/manager-trial-signup-form.tsx")).toMatch(/phoneRequired/);
  });

  it("Google / Apple sign-ups land on the portal gate, which sends an unverified account to verify-phone", () => {
    const access = read("src/lib/auth/portal-access.ts");
    expect(access).toContain("needsPhoneVerification");
    expect(access).toContain("redirect(phoneGateHref(requested))");
    // The gate is not shared-mode only any more.
    const gate = read("src/lib/auth/phone-auth.server.ts");
    expect(gate).toContain("loadPhoneRequired");
  });
});
