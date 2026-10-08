import { describe, expect, it } from "vitest";
import { nextFreeSlot, ptToUtc } from "@/lib/growth/slots";

describe("growth slots", () => {
  it("converts PT wall clock to UTC across DST", () => {
    expect(ptToUtc(2026, 10, 8, 9, 0).toISOString()).toBe("2026-10-08T16:00:00.000Z"); // PDT
    expect(ptToUtc(2026, 12, 8, 9, 0).toISOString()).toBe("2026-12-08T17:00:00.000Z"); // PST
  });
  it("picks the next default reel slot and skips a taken one", () => {
    const now = new Date("2026-10-08T15:00:00Z");
    const first = nextFreeSlot(now, "reel", ["instagram"], []);
    expect(first.toISOString()).toBe("2026-10-08T16:00:00.000Z");
    const second = nextFreeSlot(now, "reel", ["instagram"], [first.toISOString()]);
    expect(second.toISOString()).toBe("2026-10-09T16:00:00.000Z");
  });
});
