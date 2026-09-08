import { afterEach, describe, expect, it } from "vitest";
import {
  clearApplicationFeeCheckoutResume,
  clearApplicationFeeSubmitConfirm,
  loadApplicationFeeCheckoutResume,
  loadApplicationFeeSubmitConfirm,
  rememberApplicationFeeCheckoutResume,
  rememberApplicationFeeSubmitConfirm,
} from "@/lib/rental-application/fee-checkout-resume";

describe("application fee checkout resume (PRP-431)", () => {
  afterEach(() => {
    clearApplicationFeeCheckoutResume();
    clearApplicationFeeSubmitConfirm();
  });

  it("round-trips email and propertyId through sessionStorage", () => {
    rememberApplicationFeeCheckoutResume({
      email: "Guest@Example.com",
      propertyId: "mgr-demo-pioneer",
      fullLegalName: "Guest Applicant",
      axisId: "AXIS-TEST-1",
    });
    expect(loadApplicationFeeCheckoutResume()).toEqual({
      email: "guest@example.com",
      propertyId: "mgr-demo-pioneer",
      fullLegalName: "Guest Applicant",
      axisId: "AXIS-TEST-1",
    });
  });

  it("rejects incomplete stash", () => {
    rememberApplicationFeeCheckoutResume({ email: "not-an-email", propertyId: "mgr-x" });
    expect(loadApplicationFeeCheckoutResume()).toBeNull();
  });

  it("round-trips submit confirmation for remount after Stripe", () => {
    rememberApplicationFeeSubmitConfirm({
      sessionId: "cs_test_abc",
      axisId: "AXIS-123",
      email: "Guest@Example.com",
      propertyId: "mgr-demo",
      propertyTitle: "Demo House",
      guestFlow: true,
      portalFlow: false,
      setupHref: "/auth/resident-setup?token=t&id=AXIS-123",
    });
    expect(loadApplicationFeeSubmitConfirm("cs_test_abc")).toMatchObject({
      sessionId: "cs_test_abc",
      axisId: "AXIS-123",
      email: "guest@example.com",
      guestFlow: true,
    });
    expect(loadApplicationFeeSubmitConfirm("cs_other")).toBeNull();
  });
});
