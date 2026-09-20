import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const planSrc = readFileSync("src/components/portal/pro-plan.tsx", "utf8");
const sheetSrc = readFileSync("src/components/portal/pro-plan-adjust-sheet.tsx", "utf8");

/**
 * PLAN-0920-1400 rebuilt Billing & plan in the Claude settings shape: a
 * section is a title, a row is a label and its control, never a muted
 * marketing sentence under either (AGENTS.md § No subtext). The old
 * "Choose your plan" comparison heading and its sentence are gone — the plan
 * cards live behind Adjust plan as rows, described by their own entitlement
 * facts (a VALUE, not explanatory subtext) rather than a heading blurb.
 */
describe("Billing & plan pages carry no marketing subtext", () => {
  it("drops the old plan-comparison heading and its muted sentence", () => {
    expect(planSrc).not.toContain("Choose your plan");
    expect(planSrc).not.toContain("Choose the plan that fits your portfolio");
    expect(planSrc).not.toContain("Start with the tools you need today and change plans as your portfolio grows.");
  });

  it("every PortalSettingsSection title on the page is a bare label", () => {
    const titles = [...planSrc.matchAll(/<PortalSettingsSection\s+title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual(
      expect.arrayContaining(["Plan", "Invoices", "Cancellation"]),
    );
    for (const title of titles) {
      expect(title.length).toBeLessThan(30);
    }
  });

  it("the Adjust plan sheet states entitlements as one fact line, not a bulleted description", () => {
    expect(sheetSrc).toContain("entitlementLine(tier)");
    expect(sheetSrc).not.toMatch(/<ul[^>]*>[\s\S]*?entitlementLine/);
  });
});
