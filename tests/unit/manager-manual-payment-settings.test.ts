import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
  normalizeManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";

describe("manager manual payment settings", () => {
  it("defaults to Stripe on with Zelle/Venmo retired", () => {
    expect(normalizeManagerManualPaymentSettings(null)).toEqual({
      ...DEFAULT_MANAGER_MANUAL_PAYMENT_SETTINGS,
      receiptAutoMarkEnabled: true,
    });
  });

  it("always forces Zelle/Venmo off regardless of stored values", () => {
    expect(
      normalizeManagerManualPaymentSettings({
        zellePaymentsEnabled: true,
        zelleContact: "pay@example.com",
        venmoPaymentsEnabled: true,
        venmoContact: "@payme",
      }),
    ).toEqual({
      axisPaymentsEnabled: true,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "resident",
    });
  });

  it("sanitizes contacts and respects axisPaymentsEnabled", () => {
    expect(
      normalizeManagerManualPaymentSettings({
        axisPaymentsEnabled: false,
        zellePaymentsEnabled: true,
        zelleContact: "name@email.com",
        venmoPaymentsEnabled: false,
        venmoContact: "",
      }),
    ).toEqual({
      axisPaymentsEnabled: false,
      zellePaymentsEnabled: false,
      zelleContact: "",
      venmoPaymentsEnabled: false,
      venmoContact: "",
      receiptAutoMarkEnabled: true,
      serviceFeePayer: "resident",
    });
  });
});
