import { describe, expect, it } from "vitest";

import {
  listingAttributionForcedOn,
  listingAttributionLine,
  normalizeListingAttributionSetting,
  resolveShowListingAttribution,
} from "@/lib/listing-attribution";

describe("listing attribution rule", () => {
  it("Free is always on, whatever the workspace stored", () => {
    const plan = { ok: true as const, tier: "free" as const };
    expect(resolveShowListingAttribution({ plan, setting: false })).toBe(true);
    expect(resolveShowListingAttribution({ plan, setting: true })).toBe(true);
    expect(listingAttributionForcedOn(plan)).toBe(true);
  });

  it("Pro and Business follow the workspace setting", () => {
    for (const tier of ["pro", "business"] as const) {
      const plan = { ok: true as const, tier };
      expect(resolveShowListingAttribution({ plan, setting: false })).toBe(false);
      expect(resolveShowListingAttribution({ plan, setting: true })).toBe(true);
      expect(listingAttributionForcedOn(plan)).toBe(false);
    }
  });

  it("a paid account with no committed tier follows the setting; an unreadable plan fails closed to on", () => {
    expect(resolveShowListingAttribution({ plan: { ok: true, tier: null }, setting: false })).toBe(false);
    expect(resolveShowListingAttribution({ plan: { ok: false }, setting: false })).toBe(true);
  });

  it("the stored setting is on unless it is an explicit show: false", () => {
    expect(normalizeListingAttributionSetting(undefined)).toBe(true);
    expect(normalizeListingAttributionSetting(null)).toBe(true);
    expect(normalizeListingAttributionSetting("false")).toBe(true);
    expect(normalizeListingAttributionSetting({})).toBe(true);
    expect(normalizeListingAttributionSetting({ show: true })).toBe(true);
    expect(normalizeListingAttributionSetting({ show: false })).toBe(false);
  });

  it("the line names the partner page on the given origin", () => {
    expect(listingAttributionLine("https://proplane.ai/")).toBe("Listed with PropLane — free for landlords: https://proplane.ai/partner");
  });
});
