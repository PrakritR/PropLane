import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_NOTIFICATION_CATEGORIES,
  managerNotificationCategoryForEvent,
  normalizeManagerNotificationCategories,
  normalizeManagerNotificationDestination,
  resolveManagerNotificationRoute,
} from "@/lib/manager-notification-preferences";

describe("manager notification preferences", () => {
  it("defaults to the in-app Assistant route and enables every topic", () => {
    expect(normalizeManagerNotificationDestination(undefined)).toBe("assistant");
    expect(normalizeManagerNotificationCategories(null)).toEqual(
      DEFAULT_MANAGER_NOTIFICATION_CATEGORIES,
    );
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
  });
});
