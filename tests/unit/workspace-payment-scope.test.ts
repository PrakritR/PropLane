import { describe, expect, it } from "vitest";
import { resolveServiceFeePayerFor } from "@/lib/payment-policy";

/**
 * Payment setup is answered once per workspace (captain, 2026-09-13). The modal
 * used to ask which PROPERTIES a processing-fee choice applied to, so a manager
 * could pick three of nine houses and leave the other six on whatever they had,
 * with nothing on screen saying so.
 *
 * The workspace sits between the house and the account: staff override → this
 * house → its workspace → the account → resident.
 */
describe("who pays the processing fee, narrowest answer first", () => {
  it("uses the workspace when the house has no choice of its own", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "business", workspaceChoice: "manager", managerChoice: "resident" }),
    ).toBe("manager");
  });

  it("lets a single house differ from its workspace", () => {
    // Decision 2: the workspace is the default, not a ceiling — the same rule
    // the room pricing grid uses for a room that differs from its house.
    expect(
      resolveServiceFeePayerFor({ tier: "business", propertyChoice: "resident", workspaceChoice: "manager" }),
    ).toBe("resident");
  });

  it("falls through to the account when the workspace has said nothing", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "business", workspaceChoice: null, managerChoice: "manager" }),
    ).toBe("manager");
  });

  it("still ends at resident when nothing anywhere has an opinion", () => {
    expect(resolveServiceFeePayerFor({ tier: "business" })).toBe("resident");
  });

  it("staff override outranks the workspace", () => {
    expect(
      resolveServiceFeePayerFor({
        tier: "business",
        adminOverride: "proplane",
        propertyChoice: "resident",
        workspaceChoice: "manager",
      }),
    ).toBe("proplane");
  });
});

describe("a workspace cannot buy what the account is not entitled to", () => {
  it("a workspace choosing PropLane still needs a real coverage grant", () => {
    expect(
      resolveServiceFeePayerFor({ tier: "business", workspaceChoice: "proplane", waiverGranted: false }),
    ).toBe("resident");
    expect(
      resolveServiceFeePayerFor({ tier: "business", workspaceChoice: "proplane" }),
    ).toBe("resident");
    expect(
      resolveServiceFeePayerFor({ tier: "business", workspaceChoice: "proplane", waiverGranted: true }),
    ).toBe("proplane");
  });

  it("a workspace choosing manager-pays is still refused on Free", () => {
    // Manager-absorb is a paid capability; moving the setting to the workspace
    // must not become a way around the plan.
    expect(resolveServiceFeePayerFor({ tier: "free", workspaceChoice: "manager" })).toBe("resident");
    expect(resolveServiceFeePayerFor({ tier: "pro", workspaceChoice: "manager" })).toBe("manager");
  });
});

describe("the single-workspace account every live manager has", () => {
  it("behaves exactly as the account-wide setting did", () => {
    // Production: 10 workspaces, 10 owners, none with a second one. The backfill
    // puts each account's value on its own default workspace, so the answer is
    // the same whether it is read from the workspace or the account.
    const viaAccount = resolveServiceFeePayerFor({ tier: "business", managerChoice: "manager" });
    const viaWorkspace = resolveServiceFeePayerFor({ tier: "business", workspaceChoice: "manager" });
    expect(viaWorkspace).toBe(viaAccount);
  });
});
