import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The management fee is automatic: the owner is never asked to sign, and no admin flag says "sign the fee agreement". */
describe("no fee agreement signing in the UI", () => {
  const panel = readFileSync("src/components/portal/finances/owner-payouts-panel.tsx", "utf8");
  it("the owner payouts panel has no signing step", () => {
    expect(panel).not.toMatch(/owner-finances-sign|owner-finances-agreement|\/sign`|Management agreement/);
    expect(panel).toContain("owner-finances-fee");
  });
  it("nothing raises a 'Sign the fee agreement' item", () => {
    const unpolicied = readFileSync("src/lib/managed-finance/unpolicied-service.server.ts", "utf8");
    expect(unpolicied).not.toMatch(/Sign the fee agreement/);
  });
  it("the admin Service row offers the management fee", () => {
    const admin = readFileSync("src/components/portal/admin-service-panel.tsx", "utf8");
    expect(admin).toContain("admin-service-fee");
  });
});
