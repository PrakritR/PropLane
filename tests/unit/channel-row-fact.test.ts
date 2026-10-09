import { describe, expect, it } from "vitest";
import { channelRowFact, relativeSyncTime } from "@/lib/channel-calendar/channel-row-fact";

const now = Date.parse("2026-10-08T12:00:00Z");

describe("channelRowFact", () => {
  it("is empty with nothing linked", () => {
    expect(channelRowFact({ linked: 0, total: 3 })).toBe("");
  });
  it("notes rooms still needing a listing", () => {
    expect(channelRowFact({ linked: 2, total: 3, lastSyncedAt: "2026-10-08T11:55:00Z", now })).toBe(
      "Connected · 2 of 3 rooms · both ways · synced 5 min ago · 1 needs a listing",
    );
  });
  it("drops the need-a-listing tail when all linked", () => {
    expect(channelRowFact({ linked: 1, total: 1, now })).toBe("Connected · 1 of 1 room · both ways");
  });
  it("formats relative times", () => {
    expect(relativeSyncTime(null)).toBe("—");
    expect(relativeSyncTime("2026-10-08T12:00:00Z", now)).toBe("just now");
    expect(relativeSyncTime("2026-10-08T09:00:00Z", now)).toBe("3 h ago");
  });
});
