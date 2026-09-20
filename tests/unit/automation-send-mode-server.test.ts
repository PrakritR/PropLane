/**
 * `resolveAutomationSendModeForEvent`'s fallback ladder (PLAN-0916-1040):
 * house override -> WORKSPACE value -> built-in default. A property lookup
 * failure (foreign id, transient read error) must never silently apply the
 * built-in auto/auto default over a manager's own workspace choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOwner = vi.fn();
const loadForProperty = vi.fn();
const loadWorkspace = vi.fn();

vi.mock("@/lib/property-owner.server", () => ({
  resolvePropertyOwnerUserId: (...args: unknown[]) => resolveOwner(...args),
}));
vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsForProperty: (...args: unknown[]) => loadForProperty(...args),
  loadReminderSettings: (...args: unknown[]) => loadWorkspace(...args),
}));

import { resolveAutomationSendModeForEvent } from "@/lib/automation-send-mode.server";
import { DEFAULT_AUTOMATION_SEND_MODE_SETTINGS } from "@/lib/automation-send-mode";

const db = {} as never;
const MGR = "mgr-1";

beforeEach(() => {
  resolveOwner.mockReset();
  loadForProperty.mockReset();
  loadWorkspace.mockReset();
});

describe("resolveAutomationSendModeForEvent", () => {
  it("returns the house's own automationSendMode when the property lookup succeeds", async () => {
    resolveOwner.mockResolvedValue(MGR);
    loadForProperty.mockResolvedValue({ automationSendMode: { team: "draft", partyFacing: "draft" } });
    const mode = await resolveAutomationSendModeForEvent(db, { managerUserId: MGR, propertyId: "house-a" });
    expect(mode).toEqual({ team: "draft", partyFacing: "draft" });
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to the WORKSPACE'S OWN send mode when the property lookup fails — never the built-in default", async () => {
    resolveOwner.mockResolvedValue(MGR);
    loadForProperty.mockRejectedValue(new Error("foreign property"));
    loadWorkspace.mockResolvedValue({ automationSendMode: { team: "draft", partyFacing: "auto" } });
    const mode = await resolveAutomationSendModeForEvent(db, { managerUserId: MGR, propertyId: "not-mine" });
    expect(mode).toEqual({ team: "draft", partyFacing: "auto" });
    expect(loadWorkspace).toHaveBeenCalledWith(db, MGR);
  });

  it("falls back to the WORKSPACE'S OWN send mode when the property is missing entirely", async () => {
    resolveOwner.mockResolvedValue(null);
    loadForProperty.mockRejectedValue(new Error("not found"));
    loadWorkspace.mockResolvedValue({ automationSendMode: { team: "auto", partyFacing: "draft" } });
    const mode = await resolveAutomationSendModeForEvent(db, { managerUserId: MGR, propertyId: null });
    expect(mode).toEqual({ team: "auto", partyFacing: "draft" });
  });

  it("falls all the way through to the built-in default only when the workspace read ALSO fails", async () => {
    resolveOwner.mockResolvedValue(MGR);
    loadForProperty.mockRejectedValue(new Error("foreign property"));
    loadWorkspace.mockRejectedValue(new Error("db down"));
    const mode = await resolveAutomationSendModeForEvent(db, { managerUserId: MGR, propertyId: "not-mine" });
    expect(mode).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
  });

  it("an empty managerUserId short-circuits to the built-in default without any lookup", async () => {
    const mode = await resolveAutomationSendModeForEvent(db, { managerUserId: "  " });
    expect(mode).toEqual(DEFAULT_AUTOMATION_SEND_MODE_SETTINGS);
    expect(resolveOwner).not.toHaveBeenCalled();
  });
});
