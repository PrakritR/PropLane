import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_SEND_MODE_SETTINGS,
  normalizeAutomationSendModeSettings,
} from "@/lib/automation-send-mode";

describe("automation-send-mode", () => {
  it("defaults team to auto-send and party-facing to auto (conservative default — see module doc)", () => {
    expect(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS).toEqual({ team: "auto", partyFacing: "auto" });
  });

  it("normalizes a missing/malformed row to defaults", () => {
    expect(normalizeAutomationSendModeSettings(null)).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
    expect(normalizeAutomationSendModeSettings(undefined)).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
    expect(normalizeAutomationSendModeSettings("nonsense")).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
    expect(normalizeAutomationSendModeSettings({})).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
  });

  it("rejects an invalid mode value, keeping the default for that field only", () => {
    expect(normalizeAutomationSendModeSettings({ team: "sometimes", partyFacing: "draft" })).toEqual({
      team: "auto",
      partyFacing: "draft",
    });
  });

  it("round-trips a manager's explicit draft-for-review opt-in", () => {
    const stored = { team: "draft", partyFacing: "draft" };
    expect(normalizeAutomationSendModeSettings(stored)).toEqual(stored);
  });
});
