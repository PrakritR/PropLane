// @vitest-environment jsdom
//
// The Pricing gear's pop-up is gone and its rows moved onto the Pricing step.
// Both things that pop-up carried have to come with them: which scope a payment
// row is in ("Workspace default" vs "This property"), and the way back out of a
// property's own answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  markPaymentFieldOwn,
  paymentSettingsFieldScope,
  resetPaymentFieldToWorkspace,
} from "@/lib/property-payment-settings-scope";
import { renderListingPricing } from "./helpers/listing-pricing-workspace-harness";

afterEach(() => cleanup());

const scopeOf = (field: string) =>
  document.querySelector(`[data-attr="listing-v2-payment-scope-${field}"]`)?.textContent;
const resetOf = (field: string) =>
  document.querySelector<HTMLElement>(`[data-attr="listing-v2-payment-reset-${field}"]`);

describe("payment settings scope", () => {
  it("reads as the workspace default until the property answers for itself", () => {
    const sub = createDefaultListingSubmission();
    expect(paymentSettingsFieldScope(sub, "rentDueDayMode")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "lateFeeGraceDays")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "serviceFeeWaiverCode")).toBe("workspace");
    expect(paymentSettingsFieldScope(sub, "serviceFeePayer", { serviceFeePayer: "manager" })).toBe("own");
  });

  it("resets a field the property took over back to the workspace default", () => {
    const base = createDefaultListingSubmission();
    const edited = markPaymentFieldOwn({ ...base, lateFeeGraceDays: 12 }, "lateFeeGraceDays");
    expect(paymentSettingsFieldScope(edited, "lateFeeGraceDays")).toBe("own");

    const reset = resetPaymentFieldToWorkspace(edited, "lateFeeGraceDays", null);
    expect(reset.lateFeeGraceDays).toBe(5);
    expect(reset.paymentSettingsScope?.lateFeeGraceDays).toBeUndefined();
    expect(paymentSettingsFieldScope(reset, "lateFeeGraceDays")).toBe("workspace");
  });

  it("puts the processing fee payer back on the workspace's answer", () => {
    const ws = { serviceFeePayer: "manager" as const };
    const edited = markPaymentFieldOwn({ ...createDefaultListingSubmission(), serviceFeePayer: "proplane" }, "serviceFeePayer");
    const reset = resetPaymentFieldToWorkspace(edited, "serviceFeePayer", ws);
    expect(reset.serviceFeePayer).toBe("manager");
    expect(paymentSettingsFieldScope(reset, "serviceFeePayer", ws)).toBe("workspace");
  });

  it("clears a coverage code the property typed", () => {
    const edited = markPaymentFieldOwn(
      { ...createDefaultListingSubmission(), serviceFeeWaiverCode: "FREE100" },
      "serviceFeeWaiverCode",
    );
    expect(paymentSettingsFieldScope(edited, "serviceFeeWaiverCode")).toBe("own");
    const reset = resetPaymentFieldToWorkspace(edited, "serviceFeeWaiverCode", null);
    expect(reset.serviceFeeWaiverCode).toBeUndefined();
    expect(paymentSettingsFieldScope(reset, "serviceFeeWaiverCode")).toBe("workspace");
  });
});

describe("Pricing step payment rows", () => {
  it("names each row's scope and offers a reset only once the property owns it", () => {
    renderListingPricing({});
    expect(scopeOf("rentDueDayMode")).toBe("Workspace default");
    expect(scopeOf("lateFeeEnabled")).toBe("Workspace default");
    expect(resetOf("lateFeeEnabled")).toBeNull();

    const lateFees = screen.getByLabelText("Automatic late fees") as HTMLInputElement;
    fireEvent.click(lateFees);
    expect(scopeOf("lateFeeEnabled")).toBe("This property");

    const reset = resetOf("lateFeeEnabled");
    expect(reset).not.toBeNull();
    fireEvent.click(reset!);
    expect((screen.getByLabelText("Automatic late fees") as HTMLInputElement).checked).toBe(true);
    expect(scopeOf("lateFeeEnabled")).toBe("Workspace default");
  });
});
