import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("obsolete email identity surfaces", () => {
  it("does not expose email account/roles or a direct admin registration endpoint", () => {
    expect(existsSync("src/app/api/auth/account-email-status/route.ts")).toBe(false);
    expect(existsSync("src/app/api/auth/register-admin/route.ts")).toBe(false);
    // The ~900-line password create-account client that used to carry this is gone; the live
    // create-account surface is the email-proof signup.
    expect(existsSync("src/app/auth/create-account/create-account-client.tsx")).toBe(false);
    expect(readFileSync("src/components/auth/email-first-signup.tsx", "utf8")).not.toContain("account-email-status");
  });
  it("does not expose the former email-only application relink helper", () => {
    expect(readFileSync("src/lib/auth/resident-setup-token.ts", "utf8")).not.toContain("relinkResidentSetupApplicationEmail");
  });
});
