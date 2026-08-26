import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  normalizeManagerAutomationSettings,
  scheduledOverrideId,
  isLegacyReminderCancelled,
  paymentReminderDedupId,
} from "@/lib/payment-automation-settings";

describe("payment-automation-settings", () => {
  it("normalizes pre-due days uniquely and sorted descending", () => {
    const settings = normalizeManagerAutomationSettings({
      preDueReminderDays: [1, 3, 3, 30, -1, 1.6],
    });
    expect(settings.preDueReminderDays).toEqual([30, 3, 2, 1]);
  });

  it("builds stable override ids", () => {
    expect(
      scheduledOverrideId({
        managerUserId: "mgr-uuid-1234",
        chargeId: "hc_rent_1",
        kind: "pre_due",
        daysBeforeDue: 3,
      }),
    ).toContain("hc_rent_1");
  });

  it("maps legacy cancelled reminder slots", () => {
    expect(isLegacyReminderCancelled(["3d", "12h"], "pre_due", 3)).toBe(true);
    expect(isLegacyReminderCancelled(["3d"], "same_day")).toBe(false);
    expect(isLegacyReminderCancelled(["12h"], "same_day")).toBe(true);
  });

  it("uses modern dedup ids for pre-due reminders", () => {
    expect(paymentReminderDedupId({ kind: "pre_due", chargeId: "hc_1", daysBeforeDue: 3 })).toBe(
      "payment_reminder_pre_3d_hc_1",
    );
  });

  it("defaults visibility mode to days_before_send", () => {
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.scheduleVisibilityMode).toBe("days_before_send");
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.scheduleVisibilityDays).toBe(3);
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.preDueReminderDays).toEqual([3, 2, 1]);
  });

  it("defaults to daily overdue reminders instead of one-time post-due", () => {
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.postDueReminderDays).toEqual([]);
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.overdueDailyEnabled).toBe(true);
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.overdueDailyStartDays).toBe(1);
  });

  it("migrates legacy post-due day 1 to daily overdue when not explicitly disabled", () => {
    const settings = normalizeManagerAutomationSettings({
      postDueReminderDays: [1],
    });
    expect(settings.postDueReminderDays).toEqual([]);
    expect(settings.overdueDailyEnabled).toBe(true);
    expect(settings.overdueDailyStartDays).toBe(1);
  });

  it("preserves an explicitly stored overdueDailyEnabled: false, even with legacy day-1 data", () => {
    const settings = normalizeManagerAutomationSettings({
      postDueReminderDays: [1],
      overdueDailyEnabled: false,
    });
    expect(settings.overdueDailyEnabled).toBe(false);
  });

  it("preserves an explicitly stored overdueDailyEnabled: true", () => {
    const settings = normalizeManagerAutomationSettings({ overdueDailyEnabled: true });
    expect(settings.overdueDailyEnabled).toBe(true);
  });

  it("defaults overdueDailyEnabled to false when no setting was ever saved", () => {
    expect(normalizeManagerAutomationSettings(null).overdueDailyEnabled).toBe(false);
    expect(normalizeManagerAutomationSettings(undefined).overdueDailyEnabled).toBe(false);
    expect(normalizeManagerAutomationSettings({}).overdueDailyEnabled).toBe(false);
  });
});

describe("late-fee opt-in", () => {
  it("defaults late-fee notices OFF", () => {
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.lateFeeNoticeEnabled).toBe(false);
    expect(normalizeManagerAutomationSettings({}).lateFeeNoticeEnabled).toBe(false);
  });

  it("defaults inbox AI draft auto-send OFF", () => {
    expect(DEFAULT_MANAGER_AUTOMATION_SETTINGS.inboxAiDraftAutoSend).toBe(false);
    expect(normalizeManagerAutomationSettings({}).inboxAiDraftAutoSend).toBe(false);
    expect(normalizeManagerAutomationSettings({ inboxAiDraftAutoSend: true }).inboxAiDraftAutoSend).toBe(true);
  });

  it("legacy rows without the field stay OFF; explicit true opts in", () => {
    expect(
      normalizeManagerAutomationSettings({ preDueReminderDays: [3] }).lateFeeNoticeEnabled,
    ).toBe(false);
    expect(
      normalizeManagerAutomationSettings({ lateFeeNoticeEnabled: true }).lateFeeNoticeEnabled,
    ).toBe(true);
  });
});
