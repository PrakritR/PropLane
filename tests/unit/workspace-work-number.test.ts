import { describe, expect, it } from "vitest";
import type { ManagerMessagingNumber } from "@/lib/sms/manager-messaging-number";
import { workNumberAwaitingCarrier, workspaceWorkNumber } from "@/lib/sms/manager-messaging-number";

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

describe("workNumberAwaitingCarrier", () => {
  const number = (over: Partial<ManagerMessagingNumber> = {}): ManagerMessagingNumber => ({
    state: "active",
    registrationState: "approved",
    carrierRegistrationState: "registered",
    attachmentState: "attached",
    phoneNumber: "+12065550199",
    lastError: null,
    ...over,
  });

  it("is true only while a real number is still short of carrier registration", () => {
    expect(workNumberAwaitingCarrier({ number: number({ carrierRegistrationState: "pending" }) })).toBe(true);
    expect(workNumberAwaitingCarrier({ number: number({ carrierRegistrationState: "not_submitted" }) })).toBe(true);
    expect(workNumberAwaitingCarrier({ number: number({ registrationState: "pending" }) })).toBe(true);
    expect(workNumberAwaitingCarrier({ number: number({ state: "provisioning", carrierRegistrationState: "pending" }) })).toBe(
      true,
    );
  });

  it("never blames the carrier for a fully registered line, nor for a missing one", () => {
    // Out of workspace credit or the deployment's send switch off: registered,
    // just not sending.
    expect(workNumberAwaitingCarrier({ number: number() })).toBe(false);
    expect(workNumberAwaitingCarrier({ number: number({ phoneNumber: null }) })).toBe(false);
    expect(workNumberAwaitingCarrier({ number: number({ state: "pending_registration" }) })).toBe(false);
    expect(workNumberAwaitingCarrier({ number: null })).toBe(false);
    expect(workNumberAwaitingCarrier(null)).toBe(false);
    expect(workNumberAwaitingCarrier(undefined)).toBe(false);
  });

  it("is false for a teammate, who has no number row of their own to be pending", () => {
    // The workspace line lives on `workspaceNumber`; `number` is always null
    // for a pure co-manager, so the carrier is never named at them.
    expect(workNumberAwaitingCarrier({ number: null })).toBe(false);
  });
});
