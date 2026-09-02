import { describe, expect, it } from "vitest";
import { reminderAnchorMatches } from "@/lib/reminders/current.server";

describe("reminderAnchorMatches", () => {
  it("matches equivalent instants", () => {
    expect(reminderAnchorMatches("2026-09-03T12:00:00Z", "2026-09-03T08:00:00-04:00")).toBe(true);
  });

  it("rejects moved and missing anchors", () => {
    expect(reminderAnchorMatches("2026-09-03T12:00:00Z", "2026-09-03T13:00:00Z")).toBe(false);
    expect(reminderAnchorMatches("2026-09-03T12:00:00Z", null)).toBe(false);
  });
});
