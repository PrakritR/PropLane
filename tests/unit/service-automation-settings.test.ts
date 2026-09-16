import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVICE_AUTOMATION_SETTINGS,
  normalizeServiceAutomationSettings,
  offerExpiresAt,
  responsePromisePhrase,
} from "@/lib/service-automation-settings";

describe("service automation settings", () => {
  it("returns defaults for junk and clamps enumerations", () => {
    expect(normalizeServiceAutomationSettings(null)).toEqual(DEFAULT_SERVICE_AUTOMATION_SETTINGS);
    const settings = normalizeServiceAutomationSettings({ offerExpiryHours: 99, autoCloseHours: "48", responsePromise: "whenever", requireOnMyWay: true });
    expect(settings.offerExpiryHours).toBe(24);
    expect(settings.autoCloseHours).toBe(48);
    expect(settings.responsePromise).toBe("1_business_day");
    expect(settings.requireOnMyWay).toBe(true);
  });

  it("computes the offer deadline from the setting, or never", () => {
    const sent = new Date("2026-09-16T10:00:00Z");
    expect(offerExpiresAt(normalizeServiceAutomationSettings({ offerExpiryHours: 4 }), sent)?.toISOString()).toBe("2026-09-16T14:00:00.000Z");
    expect(offerExpiresAt(normalizeServiceAutomationSettings({ offerExpiryHours: 0 }), sent)).toBeNull();
  });

  it("phrases the promise for the acknowledgement copy", () => {
    expect(responsePromisePhrase("4_hours")).toBe("within 4 hours");
    expect(responsePromisePhrase("none")).toBe("");
  });
});
