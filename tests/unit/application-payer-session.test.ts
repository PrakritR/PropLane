import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applicationPayerSessionMatches } from "@/lib/rental-application/application-payer-session";

const phoneOnly = { sessionUserId: "user-1", sessionEmail: "4b1c@phone.proplane.invalid", residentEmail: "ava@example.com" };

describe("applicationPayerSessionMatches", () => {
  it("lets a phone sign-up account pay the fee on the application bound to it", () => {
    expect(applicationPayerSessionMatches({ ...phoneOnly, rowData: { residentUserId: "user-1" } })).toBe(true);
  });

  it("refuses a phone account on an application bound to someone else, or to nobody", () => {
    expect(applicationPayerSessionMatches({ ...phoneOnly, rowData: { residentUserId: "user-2" } })).toBe(false);
    expect(applicationPayerSessionMatches({ ...phoneOnly, rowData: {} })).toBe(false);
    expect(applicationPayerSessionMatches({ ...phoneOnly, rowData: null })).toBe(false);
  });

  it("keeps the mailbox rule for an email account", () => {
    expect(applicationPayerSessionMatches({ sessionUserId: "u", sessionEmail: "Ava@Example.com", residentEmail: "ava@example.com", rowData: {} })).toBe(true);
    expect(applicationPayerSessionMatches({ sessionUserId: "u", sessionEmail: "bo@example.com", residentEmail: "ava@example.com", rowData: {} })).toBe(false);
  });

  it("never matches without a session", () => {
    expect(applicationPayerSessionMatches({ sessionUserId: null, sessionEmail: "ava@example.com", residentEmail: "ava@example.com", rowData: { residentUserId: "" } })).toBe(false);
  });

  it("is the decision both fee routes use", () => {
    for (const route of ["src/app/api/stripe/application-fee-checkout/route.ts", "src/app/api/public/application-fee-waiver/route.ts"]) {
      const source = readFileSync(route, "utf8");
      expect(source).toContain("applicationPayerSessionMatches(");
      expect(source).not.toMatch(/user\?\.email\?\.trim\(\)\.toLowerCase\(\) === residentEmail/);
    }
  });
});
