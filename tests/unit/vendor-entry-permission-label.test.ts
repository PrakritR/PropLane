import { describe, expect, it } from "vitest";
import { vendorEntryPermissionLabel } from "@/lib/work-order-entry";

describe("vendorEntryPermissionLabel", () => {
  it("words every entry answer for the vendor, never the raw enum", () => {
    expect(vendorEntryPermissionLabel("call_first")).toBe("Call first");
    expect(vendorEntryPermissionLabel("resident_present")).toBe("Resident home");
    expect(vendorEntryPermissionLabel("allowed")).toBe("Can enter");
    expect(vendorEntryPermissionLabel(undefined)).toBe("Call first");
  });
});
