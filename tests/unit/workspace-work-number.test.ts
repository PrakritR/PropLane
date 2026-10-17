import { describe, expect, it } from "vitest";
import { workspaceWorkNumber } from "@/lib/sms/manager-messaging-number";

describe("workspaceWorkNumber", () => {
  it("reads the owner's line for a co_manager", () => {
    expect(
      workspaceWorkNumber({
        workspaceRole: "co_manager",
        number: { phoneNumber: "+15550000001" },
        workspaceNumber: { phoneNumber: " +12065550199 " },
      }),
    ).toBe("+12065550199");
  });

  it("never lets a teammate's own legacy row stand in for the workspace line", () => {
    expect(
      workspaceWorkNumber({
        workspaceRole: "co_manager",
        number: { phoneNumber: "+15550000001" },
        workspaceNumber: { phoneNumber: null },
      }),
    ).toBeNull();
    expect(workspaceWorkNumber({ workspaceRole: "co_manager", number: { phoneNumber: "+1555" } })).toBeNull();
  });

  it("reads the viewer's own number for an owner", () => {
    expect(
      workspaceWorkNumber({ workspaceRole: "primary", number: { phoneNumber: " +15550000001 " }, workspaceNumber: null }),
    ).toBe("+15550000001");
  });

  it("is null for blank, missing, or unreadable status", () => {
    expect(workspaceWorkNumber(null)).toBeNull();
    expect(workspaceWorkNumber(undefined)).toBeNull();
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: null })).toBeNull();
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: { phoneNumber: "   " } })).toBeNull();
  });
});
