import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_NOTIFICATION_CATEGORIES,
  managerNotificationCategoryForEvent,
  normalizeManagerAttentionDigestCadence,
  normalizeManagerNotificationCategories,
  normalizeManagerNotificationDestination,
  resolveManagerNotificationRoute,
} from "@/lib/manager-notification-preferences";

describe("manager notification preferences", () => {
  it("defaults to PropLane AND a text, and enables every topic", () => {
    // Was "assistant" — PropLane plus the always-on email leg, never a text, so
    // the channel a manager reads soonest was off unless they went and found
    // the setting. "both" only turns the preference on; the hard gates (topic
    // enabled, verified cell, active work number) still decide.
    expect(normalizeManagerNotificationDestination(undefined)).toBe("both");
    expect(normalizeManagerNotificationCategories(null)).toEqual(
      DEFAULT_MANAGER_NOTIFICATION_CATEGORIES,
    );
    expect(normalizeManagerAttentionDigestCadence(undefined)).toBe("off");
    expect(normalizeManagerAttentionDigestCadence("weekly")).toBe("weekly");
  });

  it("falls back to Assistant until both phone legs are ready", () => {
    expect(
      resolveManagerNotificationRoute({
        destination: "personal_number",
        categoryEnabled: true,
        personalPhoneReady: true,
        workNumberReady: false,
      }),
    ).toEqual({ assistant: true, sms: false, fellBackToAssistant: true });
  });

  it("automatically switches the default route to SMS when the connection is ready", () => {
    expect(
      resolveManagerNotificationRoute({
        destination: "personal_number",
        categoryEnabled: true,
        personalPhoneReady: true,
        workNumberReady: true,
      }),
    ).toEqual({ assistant: false, sms: true, fellBackToAssistant: false });
  });

  it("silences proactive reminders when no updates is selected", () => {
    expect(
      resolveManagerNotificationRoute({
        destination: "none",
        categoryEnabled: true,
        personalPhoneReady: true,
        workNumberReady: true,
      }),
    ).toEqual({ assistant: false, sms: false, fellBackToAssistant: false });
  });

  it("keeps Assistant on in both mode and respects topic-level SMS opt-outs", () => {
    expect(
      resolveManagerNotificationRoute({
        destination: "both",
        categoryEnabled: false,
        personalPhoneReady: true,
        workNumberReady: true,
      }),
    ).toEqual({ assistant: true, sms: false, fellBackToAssistant: false });
  });

  it("maps existing delivery categories to manager alert topics", () => {
    expect(managerNotificationCategoryForEvent("payments")).toBe("payment_reminders");
    expect(managerNotificationCategoryForEvent("maintenance")).toBe("maintenance");
    expect(managerNotificationCategoryForEvent("leases")).toBe("leasing");
    expect(managerNotificationCategoryForEvent("applications")).toBe("applications");
    expect(managerNotificationCategoryForEvent("attention_digest")).toBe("attention_digest");
  });
});
