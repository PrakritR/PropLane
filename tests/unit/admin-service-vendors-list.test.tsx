import { describe, expect, it } from "vitest";
import { formatUsPhone, serviceVendorFacts } from "@/components/portal/admin-service-vendors-list";
import type { ServiceVendorView } from "@/lib/service/service-vendors";

const vendor = (over: Partial<ServiceVendorView> = {}): ServiceVendorView => ({
  id: "svcv-1",
  name: "Sam Locksmith",
  phone: "+12065550101",
  trades: ["locksmith", "handyman"],
  area: "Capitol Hill",
  paused: false,
  optedOut: false,
  introSentAt: null,
  hasAccount: false,
  ...over,
});
const labels = (v: ServiceVendorView) => serviceVendorFacts(v).map((f) => (typeof f === "string" ? f : String(f.label)));

describe("roster rows", () => {
  it("shows the phone as people write it and the trades by name", () => {
    expect(formatUsPhone("+12065550101")).toBe("(206) 555-0101");
    expect(labels(vendor())).toEqual(["(206) 555-0101", "Locksmith, Handyman"]);
  });

  it("adds one plain status fact only when texts are off: paused, or opted out (opted out wins)", () => {
    expect(labels(vendor({ paused: true }))).toContain("Paused");
    expect(labels(vendor({ optedOut: true, paused: true }))).toContain("Opted out");
    expect(labels(vendor({ optedOut: true, paused: true }))).not.toContain("Paused");
  });
});
