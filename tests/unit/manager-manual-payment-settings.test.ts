import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  normalizeManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";

describe("manager payment settings", () => {
  it("defaults to PropLane payments on with the resident paying the service fee", () => {
    expect(normalizeManagerManualPaymentSettings(null)).toEqual(DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS);
    expect(DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS).toEqual({ axisPaymentsEnabled: true, serviceFeePayer: "resident" });
  });

  it("drops legacy off-platform handles a stored row may still carry (PLAN-0916)", () => {
    expect(
      normalizeManagerManualPaymentSettings({
        zellePaymentsEnabled: true,
        zelleContact: "pay@example.com",
        venmoPaymentsEnabled: true,
        venmoContact: "@payme",
        receiptAutoMarkEnabled: true,
        paymentInboxToken: "abc",
      }),
    ).toEqual({ axisPaymentsEnabled: true, serviceFeePayer: "resident" });
  });

  it("respects axisPaymentsEnabled and the service-fee choice", () => {
    expect(
      normalizeManagerManualPaymentSettings({ axisPaymentsEnabled: false, serviceFeePayer: "manager" }),
    ).toEqual({ axisPaymentsEnabled: false, serviceFeePayer: "manager" });
  });
});
