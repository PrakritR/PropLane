import { existsSync, readFileSync } from "node:fs";
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
  it("the admin Service row offers the management fee, with the day it takes effect", () => {
    const admin = readFileSync("src/components/portal/admin-service-panel.tsx", "utf8");
    expect(admin).toContain("admin-service-fee");
    expect(admin).toContain("admin-service-fee-effective");
    expect(admin).toContain("nextFeeEffectiveFrom()");
  });

  // Review fix, Oct 20: the owner-facing Sign card was removed but the admin side still sent the link that opened
  // it, so the email/text led to a dead page. Signing is gone end to end.
  it("no admin Send for signature action, no route action, no sign route", () => {
    const adminPanel = readFileSync("src/components/portal/admin-managed-finance-panel.tsx", "utf8");
    expect(adminPanel).not.toMatch(/Send for signature|admin-managed-send/);
    const route = readFileSync("src/app/api/admin/managed-policies/[id]/route.ts", "utf8");
    expect(route).not.toMatch(/sendPolicyForSignature|"send"/);
    expect(existsSync("src/app/api/owner/finances/policy/[id]/sign")).toBe(false);
  });

  it("the policy library has no send or sign entry point left", () => {
    const lib = readFileSync("src/lib/owner-management/policies.server.ts", "utf8");
    expect(lib).not.toMatch(/export async function (signPolicy|sendPolicyForSignature)/);
    const gate = readFileSync("src/lib/managed-finance/routes.server.ts", "utf8");
    expect(gate).not.toMatch(/waitingPolicyIds/);
  });
});
