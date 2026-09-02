/**
 * Saying "yes, set up a number" during signup records INTENT — it never buys.
 *
 * Signup is the wrong place to spend money: the plan is not settled yet, and a
 * provider failure there would derail account creation for a reason unrelated
 * to creating an account. The intent is kept so Settings → Messaging can say
 * "you asked for this, it is waiting on your plan" rather than dropping it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
} from "@/lib/payment-automation-settings";

describe("work-number signup intent", () => {
  it("defaults to off, so an untouched account never claims to have asked", () => {
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.workNumberRequestedAtSignup).toBe(false);
  });

  it("round-trips through the stored settings blob", () => {
    const normalized = normalizeManagerAutomationSettings({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      workNumberRequestedAtSignup: true,
    });
    expect(normalized.workNumberRequestedAtSignup).toBe(true);
  });

  it("treats anything but a true boolean as not asked", () => {
    // A legacy blob has no such key; it must not read as a request.
    const legacy = normalizeManagerAutomationSettings({} as never);
    expect(legacy.workNumberRequestedAtSignup).toBe(false);
    const stringy = normalizeManagerAutomationSettings({ workNumberRequestedAtSignup: "yes" } as never);
    expect(stringy.workNumberRequestedAtSignup).toBe(false);
  });
});
