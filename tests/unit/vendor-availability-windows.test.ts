import { describe, expect, it } from "vitest";
import { isFlexibleWeeklyRule, slotKeysFromWeeklyRules, type VendorAvailabilityRule } from "@/lib/vendor-availability";

describe("vendor availability windows", () => {
  it("treats all-day Flexible notes as leftover flexible flags", () => {
    const flexible: VendorAvailabilityRule = {
      id: "r1",
      kind: "weekly",
      weekday: 1,
      startMinute: 0,
      endMinute: 1440,
      note: "Flexible",
    };
    const painted: VendorAvailabilityRule = {
      id: "r2",
      kind: "weekly",
      weekday: 1,
      startMinute: 8 * 60,
      endMinute: 18 * 60,
    };
    expect(isFlexibleWeeklyRule(flexible)).toBe(true);
    expect(isFlexibleWeeklyRule(painted)).toBe(false);
  });

  it("paints 8am–6pm Monday slots for the next week", () => {
    const monday = new Date(2026, 8, 14); // Monday local
    const keys = slotKeysFromWeeklyRules(
      [
        {
          id: "r1",
          kind: "weekly",
          weekday: 1,
          startMinute: 8 * 60,
          endMinute: 18 * 60,
        },
      ],
      monday,
      1,
    );
    expect(keys[0]).toBe("2026-09-14:16");
    expect(keys.at(-1)).toBe("2026-09-14:35");
    expect(keys).toHaveLength(20);
    expect(keys.every((key) => key.startsWith("2026-09-14:"))).toBe(true);
  });
});
