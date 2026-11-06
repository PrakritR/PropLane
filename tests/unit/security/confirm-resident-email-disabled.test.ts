import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/confirm-resident-email/route";
describe("resident email confirmation", () => {
  it("gives the same refusal for any email and never accesses account data", async () => {
    const first = await POST();
    const second = await POST();
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual(await second.json());
    const source = readFileSync("src/app/api/auth/confirm-resident-email/route.ts", "utf8");
    expect(source).not.toMatch(/updateUserById|createSupabaseServiceRoleClient|findAuthUserIdByEmail/);
  });
  it("sign-in surfaces do not invoke the removed auto-confirm behavior", () => {
    for (const path of ["src/components/auth/mobile-email-sign-in.tsx", "src/components/auth/native-auth-hub.tsx"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("/api/auth/confirm-resident-email");
      expect(source).not.toMatch(/tryResidentAutoConfirm|email_confirm/);
      expect(source).toMatch(/presentSignInError\(error\.message\)/);
    }
  });
  it("routes the unconfirmed-email case through the one copy owner", async () => {
    const { presentSignInError } = await import("@/lib/auth/sign-in-error");
    const presented = presentSignInError("Email not confirmed");
    expect(presented.credentialMismatch).toBe(false);
    expect(presented.message.toLowerCase()).toContain("email");
    for (const path of ["src/components/auth/mobile-email-sign-in.tsx", "src/components/auth/native-auth-hub.tsx"]) {
      expect(readFileSync(path, "utf8")).not.toContain("email not confirmed");
    }
  });
});
