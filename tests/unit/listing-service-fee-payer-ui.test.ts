import { describe, expect, it } from "vitest";
import {
  listingServiceFeePayerUiValue,
  managerCanSelectManagerAbsorbServiceFee,
  managerCanSelectProplaneServiceFee,
} from "@/lib/payment-policy";

describe("listing service fee payer UI helpers", () => {
  it("allows PropLane absorb on paid plans and on Free with FREE100", () => {
    expect(managerCanSelectProplaneServiceFee("pro", false)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", true)).toBe(true);
    expect(managerCanSelectProplaneServiceFee("free", false)).toBe(false);
  });

  it("allows manager absorb only on paid plans", () => {
    expect(managerCanSelectManagerAbsorbServiceFee("pro")).toBe(true);
    expect(managerCanSelectManagerAbsorbServiceFee("free")).toBe(false);
  });

  it("defaults unset listing values to proplane on paid and resident on Free", () => {
    expect(listingServiceFeePayerUiValue(null, "pro", false)).toBe("proplane");
    expect(listingServiceFeePayerUiValue(null, "free", false)).toBe("resident");
    expect(listingServiceFeePayerUiValue(null, "free", true)).toBe("proplane");
  });
});
