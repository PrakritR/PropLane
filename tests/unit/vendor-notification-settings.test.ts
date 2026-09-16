import { describe, expect, it } from "vitest";
import {
  DEFAULT_VENDOR_NOTIFICATION_SETTINGS,
  isVendorQuietHour,
  legacyFlagsFromVendorNotificationSettings,
  normalizeVendorNotificationSettings,
  vendorTopicForEvent,
} from "@/lib/vendor-notification-settings";

describe("vendor notification settings", () => {
  it("returns defaults for absent, null and junk input", () => {
    expect(normalizeVendorNotificationSettings(undefined)).toEqual(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
    expect(normalizeVendorNotificationSettings(null)).toEqual(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
    expect(normalizeVendorNotificationSettings("nope")).toEqual(DEFAULT_VENDOR_NOTIFICATION_SETTINGS);
  });

  it("seeds topics from the legacy toggles when the new blob has never been saved", () => {
    const settings = normalizeVendorNotificationSettings(undefined, {
      notifyNewOffers: false,
      notifyScheduleChanges: true,
      notifyPayments: false,
    });
    expect(settings.topics.offers).toEqual({ email: false, sms: false });
    expect(settings.topics.schedule).toEqual({ email: true, sms: true });
    expect(settings.topics.payments).toEqual({ email: false, sms: false });
    // Topics the legacy pane never had keep their defaults.
    expect(settings.topics.invoices).toEqual(DEFAULT_VENDOR_NOTIFICATION_SETTINGS.topics.invoices);
  });

  it("ignores the legacy toggles once the new blob exists", () => {
    const settings = normalizeVendorNotificationSettings(
      { topics: { offers: { email: true, sms: false } } },
      { notifyNewOffers: false, notifyScheduleChanges: false, notifyPayments: false },
    );
    expect(settings.topics.offers).toEqual({ email: true, sms: false });
    expect(settings.topics.schedule).toEqual(DEFAULT_VENDOR_NOTIFICATION_SETTINGS.topics.schedule);
  });

  it("mirrors the legacy booleans from the topics", () => {
    const settings = normalizeVendorNotificationSettings({ topics: { offers: { email: false, sms: false }, payments: { email: false, sms: true } } });
    expect(legacyFlagsFromVendorNotificationSettings(settings)).toEqual({
      notifyNewOffers: false,
      notifyScheduleChanges: true,
      notifyPayments: true,
    });
  });

  it("treats a zero-length quiet window as off and wraps midnight", () => {
    expect(normalizeVendorNotificationSettings({ quietHours: { enabled: true, startHour: 8, endHour: 8 } }).quietHours.enabled).toBe(false);
    const quiet = { enabled: true, startHour: 20, endHour: 7 };
    expect(isVendorQuietHour(quiet, 22)).toBe(true);
    expect(isVendorQuietHour(quiet, 3)).toBe(true);
    expect(isVendorQuietHour(quiet, 12)).toBe(false);
  });

  it("files every work-order event under the vendor row that gates it", () => {
    expect(vendorTopicForEvent("work_order", "vendor_offered")).toBe("offers");
    expect(vendorTopicForEvent("work_order", "offer_expired")).toBe("offers");
    expect(vendorTopicForEvent("work_order", "accepted")).toBe("schedule");
    expect(vendorTopicForEvent("work_order", "resident_reopened")).toBe("schedule");
    expect(vendorTopicForEvent("work_order", "invoice_disputed")).toBe("invoices");
    expect(vendorTopicForEvent("work_order", "paid")).toBe("payments");
    expect(vendorTopicForEvent("work_order", "rated")).toBe("reviews");
    expect(vendorTopicForEvent("message", "new")).toBe("messages");
  });
});
