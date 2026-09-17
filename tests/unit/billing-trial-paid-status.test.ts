import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Billing names trial vs paid and work number stays paid-only", () => {
  it("Billing shows Free trial vs Paid plan and Activate paid plan", () => {
    const plan = readFileSync(join(process.cwd(), "src/components/portal/pro-plan.tsx"), "utf8");
    expect(plan).toContain("Free trial of");
    expect(plan).toContain("Paid ${tierLabel(currentTier)} plan");
    expect(plan).toContain('data-attr="billing-plan-status"');
    expect(plan).toContain('data-attr="billing-activate-paid-plan"');
    expect(plan).toContain("Activate paid plan");
    expect(plan).not.toContain("billing-plan-promo-code");
    expect(plan).toContain('data-attr="plan-promo-code-input"');
    expect(plan).toContain('activatePaid');
  });

  it("Work number locks free and trial behind an upgrade banner", () => {
    const messaging = readFileSync(
      join(process.cwd(), "src/components/portal/pro-messaging-settings-panel.tsx"),
      "utf8",
    );
    expect(messaging).toContain("You're on a free trial. Upgrade to a paid plan to activate a work number.");
    expect(messaging).toContain("Free accounts cannot use a work number.");
    expect(messaging).toContain('data-attr="messaging-work-number-plan-lock"');
    expect(messaging).toContain("Activate paid plan");
    expect(messaging).toContain("/portal/profile?tab=billing&activatePaid=1");
    expect(messaging).not.toContain('data-attr="messaging-number-status-refresh"');
    expect(messaging).not.toContain('data-attr="messaging-announce-residents-open"');
    expect(messaging).toContain("refreshEligibility: true");
  });
});
