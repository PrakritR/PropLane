import { describe, expect, it } from "vitest";
import { formatInboxListNarrowTime } from "@/lib/portal-inbox-storage";

describe("formatInboxListNarrowTime", () => {
  const now = new Date("2026-10-03T15:00:00-07:00");

  it("shows clock time for Pacific today", () => {
    const stamp = formatInboxListNarrowTime("2026-10-03T09:15:00-07:00", now);
    expect(stamp).toMatch(/9:15/);
  });

  it("shows short month-day for earlier days", () => {
    const stamp = formatInboxListNarrowTime("2026-09-30T14:00:00-07:00", now);
    expect(stamp).toBe("Sep 30");
  });
});
