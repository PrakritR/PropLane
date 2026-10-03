import { describe, expect, it } from "vitest";
import { stayTypeLabelForLeaseKindDisplay } from "@/lib/property-form-stay-type-routing";

describe("stayTypeLabelForLeaseKindDisplay", () => {
  const offered = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay", "Airbnb"];

  it("calls every non-stay mapping a long-term lease, so Custom never reads as its own type", () => {
    expect(stayTypeLabelForLeaseKindDisplay(["Custom"], offered)).toBe("Long-term");
    expect(stayTypeLabelForLeaseKindDisplay(["Long-term", "Month-to-Month", "Custom"], offered)).toBe("Long-term");
  });

  it("names short-term and Airbnb stays", () => {
    expect(stayTypeLabelForLeaseKindDisplay(["Short-Term Stay"], offered)).toBe("Short term");
    expect(stayTypeLabelForLeaseKindDisplay(["Long-term", "Airbnb"], offered)).toBe("Long-term, Airbnb");
  });

  it("falls back when nothing offered is mapped", () => {
    expect(stayTypeLabelForLeaseKindDisplay([], offered)).toBe("Not assigned");
    expect(stayTypeLabelForLeaseKindDisplay(["Custom"], ["Long-term"], "Long-term")).toBe("Long-term");
  });
});
