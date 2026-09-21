/**
 * Every settings nav entry (PLAN-0920-0845 phase D) carries exactly one of:
 * a scope bar (full or workspace-only), an Account tag, or a Device tag —
 * except Workspaces, which is its own switcher and exempt from all three.
 *
 * This asserts the classification tables in `portal-profile-client.tsx`
 * directly rather than mounting the whole settings hub (which pulls in a
 * dozen fetch-backed panels): the render logic there picks its header action
 * from exactly these four sets (`barred ? <SettingsScopeBar/> : accountTagged
 * ? "Account" : deviceTagged ? "Device" : null`), so a nav id's membership
 * IS what the manager sees in the header row.
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TAG_PANES,
  DEVICE_TAG_PANES,
  SCOPED_OPERATIONS_PANES,
  SETTINGS_SCOPE_EXEMPT_PANES,
  SINGLE_WORKSPACE_PANES,
  WORKSPACE_ONLY_PANES,
  type SettingsGroupId,
} from "@/components/portal/portal-profile-client";

/** Every nav id the hub can show (manager, non-demo — the fullest set). */
const ALL_NAV_IDS: SettingsGroupId[] = [
  "profile",
  "workspaces",
  "billing",
  "notifications",
  "preferences",
  "security",
  "developer",
  "feedback",
  "account",
  "applications",
  "lease",
  "tours",
  "resident",
  "messaging",
  "payments",
  "services",
  "tasks",
  "bookings",
  "inspections",
  "reminders",
];

function classificationsFor(id: SettingsGroupId): string[] {
  const hits: string[] = [];
  if (SCOPED_OPERATIONS_PANES.has(id)) hits.push("bar");
  if (WORKSPACE_ONLY_PANES.has(id)) hits.push("bar");
  if (SINGLE_WORKSPACE_PANES.has(id)) hits.push("bar");
  if (ACCOUNT_TAG_PANES.has(id)) hits.push("account-tag");
  if (DEVICE_TAG_PANES.has(id)) hits.push("device-tag");
  if (SETTINGS_SCOPE_EXEMPT_PANES.has(id)) hits.push("exempt");
  return hits;
}

describe("settings nav entries: bar / Account tag / Device tag, exactly one", () => {
  it("every nav id is classified", () => {
    const unclassified = ALL_NAV_IDS.filter((id) => classificationsFor(id).length === 0);
    expect(unclassified).toEqual([]);
  });

  it("no nav id is double-classified", () => {
    const doubled = ALL_NAV_IDS.filter((id) => classificationsFor(id).length > 1).map(
      (id) => `${id}: ${classificationsFor(id).join(", ")}`,
    );
    expect(doubled).toEqual([]);
  });

  it("Workspaces is exempt from the bar and both tags", () => {
    expect(classificationsFor("workspaces")).toEqual(["exempt"]);
    expect(SCOPED_OPERATIONS_PANES.has("workspaces")).toBe(false);
    expect(WORKSPACE_ONLY_PANES.has("workspaces")).toBe(false);
    expect(ACCOUNT_TAG_PANES.has("workspaces")).toBe(false);
    expect(DEVICE_TAG_PANES.has("workspaces")).toBe(false);
  });

  it("the ten Portfolio + Operations modules with a per-house rung get the full scope bar", () => {
    const expected: SettingsGroupId[] = [
      "applications",
      "lease",
      "tours",
      "resident",
      "payments",
      "tasks",
      "reminders",
      "bookings",
      "inspections",
      "services",
    ];
    expect(SCOPED_OPERATIONS_PANES.size).toBe(10);
    for (const id of expected) expect(SCOPED_OPERATIONS_PANES.has(id)).toBe(true);
  });

  it("Notifications gets the workspace-only bar, not the full bar", () => {
    expect(WORKSPACE_ONLY_PANES.has("notifications")).toBe(true);
    expect(SCOPED_OPERATIONS_PANES.has("notifications")).toBe(false);
  });

  it("Communication gets the single-workspace bar, never the multi-select full/workspace-only bar", () => {
    expect(SINGLE_WORKSPACE_PANES.size).toBe(1);
    expect(SINGLE_WORKSPACE_PANES.has("messaging")).toBe(true);
    expect(SCOPED_OPERATIONS_PANES.has("messaging")).toBe(false);
    expect(WORKSPACE_ONLY_PANES.has("messaging")).toBe(false);
  });

  it("Profile, Billing, Login & security, API & MCP, Feedback, and Account carry the Account tag", () => {
    const expected: SettingsGroupId[] = ["profile", "billing", "security", "developer", "feedback", "account"];
    expect(ACCOUNT_TAG_PANES.size).toBe(expected.length);
    for (const id of expected) expect(ACCOUNT_TAG_PANES.has(id)).toBe(true);
  });

  it("Preferences carries the Device tag", () => {
    expect(DEVICE_TAG_PANES.size).toBe(1);
    expect(DEVICE_TAG_PANES.has("preferences")).toBe(true);
  });
});
