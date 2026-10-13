import { describe, expect, it } from "vitest";
import { firstNonEmptyTabToOpen } from "@/lib/portal-default-tab";

const tabs = [
  { id: "open", count: 0 },
  { id: "assigned", count: 2 },
  { id: "scheduled", count: 1 },
  { id: "completed", count: 0 },
] as const;

describe("firstNonEmptyTabToOpen", () => {
  it("moves off an empty default tab to the first tab with rows", () => {
    expect(firstNonEmptyTabToOpen(tabs, "open", false)).toBe("assigned");
  });
  it("stays when the current tab has rows", () => {
    expect(firstNonEmptyTabToOpen([{ id: "open", count: 3 }, { id: "assigned", count: 2 }], "open", false)).toBeNull();
  });
  it("never overrides a tab the URL names", () => {
    expect(firstNonEmptyTabToOpen(tabs, "open", true)).toBeNull();
  });
  it("stays when nothing has rows yet", () => {
    expect(firstNonEmptyTabToOpen([{ id: "open", count: 0 }, { id: "assigned" }], "open", false)).toBeNull();
  });
});
