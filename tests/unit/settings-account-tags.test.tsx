/**
 * Every manager settings nav entry (S019/S008/S014, captain 2026-09-27:
 * "simplify settings fully", corrected 06:47 to keep the properties picker
 * and Application form / Lease documents) carries exactly one of: a
 * workspace "Applies to" scope bar (with or without the properties picker),
 * an Account tag, or a Device tag — except Workspaces and Integrations (the
 * `spreadsheets` id), which are their own switchers and exempt from all
 * three.
 *
 * This asserts the classification tables in `portal-profile-client.tsx`
 * directly rather than mounting the whole settings hub (which pulls in a
 * dozen fetch-backed panels): the render logic there picks its header action
 * from exactly these sets (`barred ? <SettingsScopeBar variant={...}/> :
 * accountTagged ? "Account" : deviceTagged ? "Device" : null`), so a nav id's
 * membership IS what the manager sees in the header row.
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_TAG_PANES,
  DEVICE_TAG_PANES,
  SETTINGS_SCOPE_EXEMPT_PANES,
  WORKSPACE_ONLY_SCOPED_PANES,
  WORKSPACE_SCOPED_PANES,
  type SettingsGroupId,
} from "@/components/portal/portal-profile-client";

/** Every nav id the manager hub can show, non-demo — the fullest set left after S019/S014. */
const ALL_NAV_IDS: SettingsGroupId[] = [
  "profile",
  "workspaces",
  "billing",
  "security",
  "developer",
  "account",
  "messaging",
  "payments",
  "payouts",
  "applicationForm",
  "leaseDocuments",
  "spreadsheets",
];

function classificationsFor(id: SettingsGroupId): string[] {
  const hits: string[] = [];
  if (WORKSPACE_SCOPED_PANES.has(id)) hits.push("bar");
  if (WORKSPACE_ONLY_SCOPED_PANES.has(id)) hits.push("bar");
  if (ACCOUNT_TAG_PANES.has(id)) hits.push("account-tag");
  if (DEVICE_TAG_PANES.has(id)) hits.push("device-tag");
  if (SETTINGS_SCOPE_EXEMPT_PANES.has(id)) hits.push("exempt");
  return hits;
}

describe("manager settings nav entries: bar / Account tag / Device tag, exactly one", () => {
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

  it("Workspaces and Integrations are exempt from the bar and both tags", () => {
    for (const id of ["workspaces", "spreadsheets"] as const) {
      expect(classificationsFor(id)).toEqual(["exempt"]);
      expect(WORKSPACE_SCOPED_PANES.has(id)).toBe(false);
      expect(WORKSPACE_ONLY_SCOPED_PANES.has(id)).toBe(false);
      expect(ACCOUNT_TAG_PANES.has(id)).toBe(false);
      expect(DEVICE_TAG_PANES.has(id)).toBe(false);
    }
  });

  it("Communication, Payments, and Payouts carry the Applies-to bar WITH the properties picker (S014 correction)", () => {
    expect(WORKSPACE_SCOPED_PANES.size).toBe(3);
    for (const id of ["messaging", "payments", "payouts"] as const) {
      expect(WORKSPACE_SCOPED_PANES.has(id)).toBe(true);
    }
  });

  it("Application form and Lease documents carry the Applies-to bar WITHOUT the properties picker — kept per S014", () => {
    expect(WORKSPACE_ONLY_SCOPED_PANES.size).toBe(2);
    for (const id of ["applicationForm", "leaseDocuments"] as const) {
      expect(WORKSPACE_ONLY_SCOPED_PANES.has(id)).toBe(true);
      expect(WORKSPACE_SCOPED_PANES.has(id)).toBe(false);
    }
  });

  it("Profile, Billing, Login & security, API & MCP, and Account carry the Account tag", () => {
    const expected: SettingsGroupId[] = ["profile", "billing", "security", "developer", "account"];
    for (const id of expected) expect(ACCOUNT_TAG_PANES.has(id)).toBe(true);
    // Feedback stays in the set for the admin variant, which still shows that pane.
    expect(ACCOUNT_TAG_PANES.has("feedback")).toBe(true);
  });

  it("Preferences carries the Device tag (admin variant only — manager no longer shows this pane)", () => {
    expect(DEVICE_TAG_PANES.size).toBe(1);
    expect(DEVICE_TAG_PANES.has("preferences")).toBe(true);
  });
});
