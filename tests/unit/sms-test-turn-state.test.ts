import { describe, expect, it } from "vitest";

import { currentSmsTestTurn } from "@/lib/axis-assistant/sms-test-turn-state";

const turn = {
  mode: "resident" as const,
  stage: "submitted" as const,
  targetListingId: "listing-a",
  sessionId: "session-a",
  effects: [],
};

const managerTurn = {
  mode: "manager" as const,
  stage: "submitted" as const,
  targetListingId: null,
  sessionId: "session-manager",
  effects: [],
};

describe("currentSmsTestTurn", () => {
  it("keeps the submitted stage only for its current target and session", () => {
    expect(currentSmsTestTurn(turn, "listing-a", "session-a")?.stage).toBe("submitted");
  });

  it("clears stale stage metadata after a target or New chat switch", () => {
    expect(currentSmsTestTurn(turn, "listing-b", "session-a")).toBeNull();
    expect(currentSmsTestTurn(turn, "listing-a", "session-b")).toBeNull();
  });

  it("treats null and empty manager targets as the same unselected target", () => {
    expect(currentSmsTestTurn(managerTurn, "", "session-manager")).toBe(managerTurn);
    expect(currentSmsTestTurn({ ...managerTurn, targetListingId: "" }, null, "session-manager")).toBeTruthy();
  });

  it("keeps manager turns scoped to their exact session and target", () => {
    expect(currentSmsTestTurn(managerTurn, "listing-a", "session-manager")).toBeNull();
    expect(currentSmsTestTurn(managerTurn, "", "other-session")).toBeNull();
  });

  it("keeps resident turns exact when target identity is absent or changed", () => {
    const residentWithoutTarget = { ...turn, targetListingId: null };
    expect(currentSmsTestTurn(residentWithoutTarget, "", "session-a")).toBeNull();
    expect(currentSmsTestTurn(residentWithoutTarget, null, "session-a")).toBe(residentWithoutTarget);
    expect(currentSmsTestTurn(turn, "listing-a ", "session-a")).toBeNull();
  });
});
