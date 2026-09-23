import { describe, expect, it } from "vitest";
import { holdSourceFromCheckoutPurpose } from "@/lib/stripe-platform-hold.server";

describe("application fee checkout without Connect", () => {
  it("maps the application-fee purpose onto a platform hold", () => {
    expect(holdSourceFromCheckoutPurpose("rental_application_fee")).toBe("application_fee");
    expect(holdSourceFromCheckoutPurpose("household_charge")).toBe("household_charge");
    expect(holdSourceFromCheckoutPurpose("vendor_invoice_pay")).toBe("vendor_invoice");
  });
});
