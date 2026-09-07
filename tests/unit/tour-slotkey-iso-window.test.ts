import { describe, expect, it } from "vitest";
import { isoWindowFromSlotKey, slotStartMs } from "@/lib/tour-slot-math";

describe("isoWindowFromSlotKey (PRP-368)", () => {
  it("derives a 30-minute ISO window from the Pacific slotKey", () => {
    const slotKey = "2026-09-07:18";
    const startMs = slotStartMs(slotKey);
    expect(startMs).not.toBeNull();
    const window = isoWindowFromSlotKey(slotKey);
    expect(window).not.toBeNull();
    expect(window!.start).toBe(new Date(startMs!).toISOString());
    expect(window!.end).toBe(new Date(startMs! + 30 * 60 * 1000).toISOString());
  });

  it("returns null for a garbage slotKey", () => {
    expect(isoWindowFromSlotKey("not-a-slot")).toBeNull();
  });

  it("ignores a client ISO that disagrees with the slotKey", () => {
    const slotKey = "2026-09-07:18";
    const wrongClientStart = "2026-09-08T01:00:00.000Z";
    const pinned = isoWindowFromSlotKey(slotKey)!;
    expect(pinned.start).not.toBe(wrongClientStart);
    expect(new Date(pinned.start).getTime()).toBe(slotStartMs(slotKey));
  });
});
