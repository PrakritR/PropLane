import { describe, expect, it } from "vitest";
import { aggregateVendorSponsoredDelivery } from "@/lib/vendor-sponsored-delivery-state";

describe("vendor sponsored logical delivery", () => {
  it("keeps a sent email bubble sent when SMS later fails or reconciles", () => {
    expect(aggregateVendorSponsoredDelivery(["sent", "failed"])).toBe("sent");
    expect(aggregateVendorSponsoredDelivery(["sending"], "sent")).toBe("sent");
  });
  it("is sending for an authorized uncertain channel and failed only when all fail", () => {
    expect(aggregateVendorSponsoredDelivery(["failed", "sending"])).toBe("sending");
    expect(aggregateVendorSponsoredDelivery(["failed", "failed"])).toBe("failed");
  });
});
