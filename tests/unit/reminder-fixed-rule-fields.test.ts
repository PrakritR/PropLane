/**
 * `tour_interest`'s Settings row must never lie about what it will send.
 *
 * `normalizeReminderSettings` force-overwrites `tour_interest`'s saved
 * timing/audience/channels on every read, because the dispatcher
 * (`subjects/tour-interest.server.ts`) hardcodes them — a single SMS, 24
 * hours later, to the prospect. `fixed-rule-fields.ts` declares exactly which
 * fields that overwrite touches; these tests pin the two halves together so
 * the declaration and the normalizer can never drift apart, and prove the two
 * fields NOT declared fixed (`enabled`, the message template) really are
 * honoured.
 */
import { describe, expect, it } from "vitest";
import { normalizeReminderSettings } from "@/lib/reminders/rules";
import { FIXED_RULE_FIELDS, fixedRuleFields, isRuleFieldFixed } from "@/lib/reminders/fixed-rule-fields";

describe("FIXED_RULE_FIELDS.tour_interest", () => {
  it("declares timings, audience, and channels — everything the dispatcher hardcodes", () => {
    expect(FIXED_RULE_FIELDS.tour_interest?.fields).toEqual(["timings", "audience", "channels"]);
    expect(FIXED_RULE_FIELDS.tour_interest?.reason.trim().length).toBeGreaterThan(0);
  });

  it("isRuleFieldFixed / fixedRuleFields agree with the declaration", () => {
    expect(isRuleFieldFixed("tour_interest", "timings")).toBe(true);
    expect(isRuleFieldFixed("tour_interest", "audience")).toBe(true);
    expect(isRuleFieldFixed("tour_interest", "channels")).toBe(true);
    expect(fixedRuleFields("tour_interest")).toBe(FIXED_RULE_FIELDS.tour_interest);
  });

  it("no other kind is declared fixed", () => {
    expect(fixedRuleFields("tour")).toBeNull();
    expect(fixedRuleFields("payment_manager")).toBeNull();
    expect(isRuleFieldFixed("lease", "timings")).toBe(false);
  });
});

describe("normalizeReminderSettings overwrites exactly the fields FIXED_RULE_FIELDS declares fixed", () => {
  function saveDifferentValues() {
    return normalizeReminderSettings({
      rules: {
        tour_interest: {
          enabled: true,
          leadMinutes: [30],
          timings: ["before:60"],
          audience: { manager: true, counterparty: false, team: true },
          teamUserIds: ["co-manager-1"],
          inbox: false,
          email: true,
          sms: false,
          template: { subject: "Custom subject", body: "Custom saved body" },
        },
      },
    }).rules.tour_interest;
  }

  it("timings: a saved timing is discarded for the hardcoded 24-hours-after send", () => {
    const rule = saveDifferentValues();
    expect(rule.timings).toEqual(["after:1440"]);
    expect(rule.leadMinutes).toEqual([1440]);
  });

  it("audience: a saved audience is discarded for manager-off / counterparty-on / team-off", () => {
    const rule = saveDifferentValues();
    expect(rule.audience).toEqual({ manager: false, counterparty: true, team: false, vendor: false });
    expect(rule.teamUserIds).toEqual([]);
  });

  it("channels: a saved channel selection is discarded for SMS-only", () => {
    const rule = saveDifferentValues();
    expect(rule.inbox).toBe(true);
    expect(rule.email).toBe(false);
    expect(rule.sms).toBe(true);
  });

  it("preserves a saved template body — the message is NOT a fixed field", () => {
    const rule = saveDifferentValues();
    expect(rule.template?.body).toBe("Custom saved body");
  });

  it("preserves a saved enabled flag — on and off — the toggle is NOT a fixed field", () => {
    const enabledOn = normalizeReminderSettings({
      rules: { tour_interest: { enabled: true, template: { subject: "s", body: "b" } } },
    }).rules.tour_interest;
    expect(enabledOn.enabled).toBe(true);

    const enabledOff = normalizeReminderSettings({
      rules: { tour_interest: { enabled: false, template: { subject: "s", body: "b" } } },
    }).rules.tour_interest;
    expect(enabledOff.enabled).toBe(false);
  });
});
