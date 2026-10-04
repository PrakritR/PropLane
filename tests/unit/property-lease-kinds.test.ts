import { describe, expect, it } from "vitest";
import {
  normalizeLeaseTemplateKind,
  propertyLeaseTypeLabel,
  PROPERTY_LEASE_TYPE_OPTIONS,
} from "@/lib/property-lease-templates";

describe("property lease template kinds", () => {
  it("exposes four lease formats", () => {
    expect(PROPERTY_LEASE_TYPE_OPTIONS.map((o) => o.id)).toEqual([
      "short-term",
      "long-term",
      "time-based",
      "custom",
    ]);
  });

  it("normalizes legacy kinds to long-term", () => {
    expect(normalizeLeaseTemplateKind("room-rental")).toBe("long-term");
    expect(normalizeLeaseTemplateKind("month-to-month")).toBe("long-term");
    expect(normalizeLeaseTemplateKind("corporate-furnished")).toBe("long-term");
  });

  it("labels normalized kinds for managers", () => {
    expect(propertyLeaseTypeLabel("short-term")).toBe("Short-term");
    expect(propertyLeaseTypeLabel("time-based")).toBe("Time-based");
    expect(propertyLeaseTypeLabel("custom")).toBe("Custom builder");
  });
});
