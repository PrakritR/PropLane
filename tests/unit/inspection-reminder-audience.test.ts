import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_SETTINGS, normalizeReminderSettings } from "@/lib/reminders/rules";
import { reminderSubjectSettingsMeta } from "@/lib/reminders/subject-settings-meta";

/**
 * A move-in or move-out condition report is somebody's job on the day. Reminding only the
 * resident meant nobody in the office learned it had been missed, so the due reminder now
 * reaches BOTH sides by default and offers the manager as a recipient the audience switch can
 * turn off. The review alert stays manager-only — a resident has nothing to review.
 */

describe("inspection reminder defaults", () => {
  it("reminds the resident AND the manager that an inspection is due", () => {
    const rule = DEFAULT_REMINDER_SETTINGS.rules.inspection;

    expect(rule.enabled).toBe(true);
    expect(rule.audience.counterparty).toBe(true);
    expect(rule.audience.manager).toBe(true);
  });

  it("keeps the review alert manager-only", () => {
    const rule = DEFAULT_REMINDER_SETTINGS.rules.inspection_manager;

    expect(rule.audience.manager).toBe(true);
    expect(rule.audience.counterparty).toBe(false);
  });

  it("covers the move-in side and the move-out side with one anchor", () => {
    // Both moves hang off the same rule, so its timing has to be expressible in both
    // directions — a move-in nudge lands before the date, a missed move-out after it.
    const meta = reminderSubjectSettingsMeta("inspection");

    expect(meta?.directions).toEqual(expect.arrayContaining(["before", "after"]));
    expect(meta?.notifyCounterpartyLabel).toBe("Resident");
  });

  it("keeps a manager's own saved audience rather than forcing the new default on them", () => {
    const saved = normalizeReminderSettings({
      rules: { inspection: { enabled: true, timings: ["before:1440"], audience: { manager: false, counterparty: true, team: false } } },
    });

    expect(saved.rules.inspection.audience.manager).toBe(false);
  });
});
