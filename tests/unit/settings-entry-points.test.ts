import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANAGER_SETTINGS_ENTRY_POINTS,
  getPaymentsSettingsEntryPoint,
  getSettingsEntryPointForTab,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

/**
 * Mirrors the `ManagerPortalSettingsTab` union declared in
 * `pro-portal-settings-modal.tsx` (that file is owned elsewhere and does not
 * export a runtime list of its tab ids, only the type). `entryPoint()`'s own
 * `tab?: ManagerPortalSettingsTab` parameter type already makes an invalid
 * tab a compile error; this set backs that same guarantee with a runtime
 * check, per this file's own required assertions.
 */
const VALID_MANAGER_PORTAL_SETTINGS_TABS = new Set<ManagerPortalSettingsTab>([
  "applications",
  "tours",
  "lease",
  "tasks",
  "resident",
  "payments",
  "services",
  "communication",
  "bookings",
  "inspections",
  "automation",
]);

const ALL_ENTRIES = Object.values(MANAGER_SETTINGS_ENTRY_POINTS);

describe("settings entry points registry", () => {
  it("every entry's data-attr matches the settings-open-<module> scheme exactly", () => {
    for (const entry of ALL_ENTRIES) {
      // The regex on its own guards against a future entry reintroducing a
      // bespoke scheme (a "manager-…-open" or "…-settings-open" one-off).
      expect(entry.dataAttr).toMatch(/^settings-open-[a-z0-9-]+$/);
      // And it must be built from this exact entry's own id, not just any
      // string that happens to satisfy the shape above.
      expect(entry.dataAttr).toBe(`settings-open-${entry.id}`);
    }
  });

  it("every entry id that maps to a settings tab is a valid ManagerPortalSettingsTab", () => {
    const entriesWithATab = ALL_ENTRIES.filter((entry) => entry.tab !== undefined);
    // Sanity: most modules do map to a tab (vendors, background checks, and
    // the generic resident-detail fallback are the deliberate exceptions).
    expect(entriesWithATab.length).toBeGreaterThan(0);
    for (const entry of entriesWithATab) {
      expect(VALID_MANAGER_PORTAL_SETTINGS_TABS.has(entry.tab as ManagerPortalSettingsTab)).toBe(true);
    }
  });

  it("the dialog title and the button label of a module come from the same entry", () => {
    // Asserting dialogTitle === label (rather than each against its own
    // separately-typed-out expected string) is the point: if a future edit
    // changes one without the other, this fails. Two independently authored
    // "expect(x).toBe('Booking settings')" checks would not catch that.
    for (const entry of ALL_ENTRIES) {
      expect(entry.dialogTitle).toBe(entry.label);
    }
  });

  it("the payments direction variant keeps dialogTitle and label tied together too", () => {
    const incoming = getPaymentsSettingsEntryPoint("incoming");
    const outgoing = getPaymentsSettingsEntryPoint("outgoing");
    expect(incoming.dialogTitle).toBe(incoming.label);
    expect(outgoing.dialogTitle).toBe(outgoing.label);
    // The two directions must actually differ, or the parameter would be doing nothing.
    expect(outgoing.label).not.toBe(incoming.label);
    expect(incoming).toBe(MANAGER_SETTINGS_ENTRY_POINTS.payments);
  });

  it("settingsDialogTitlePrefix strips exactly the modal's own appended suffix", () => {
    // ManagerPortalSettingsModal renders `${scopedTitle} settings`. Passing
    // dialogTitle there unmodified would double the suffix, so every
    // tab-bound entry's dialogTitle must end in " settings" and the helper
    // must remove precisely that, reproducing dialogTitle when re-suffixed.
    for (const entry of ALL_ENTRIES) {
      if (!entry.tab) continue;
      expect(entry.dialogTitle).toMatch(/ settings$/i);
      const prefix = settingsDialogTitlePrefix(entry);
      expect(`${prefix} settings`).toBe(entry.dialogTitle);
    }
  });

  it("getSettingsEntryPointForTab resolves each tab-bound entry back to itself", () => {
    for (const entry of ALL_ENTRIES) {
      if (!entry.tab) continue;
      expect(getSettingsEntryPointForTab(entry.tab)).toBe(entry);
    }
  });

  it("communication and automation now resolve to their own dedicated gear, not the generic fallback", () => {
    // The Notifications hub (automation) and Communication's new settings gear
    // both got dedicated registry entries — neither falls back to the generic
    // resident-detail entry anymore. `getSettingsEntryPointForTab` still keeps
    // that fallback for a tab with no entry at all; every current tab has one.
    expect(getSettingsEntryPointForTab("communication")).toBe(
      MANAGER_SETTINGS_ENTRY_POINTS.communication,
    );
    expect(getSettingsEntryPointForTab("automation")).toBe(
      MANAGER_SETTINGS_ENTRY_POINTS.notifications,
    );
  });
});

/**
 * Old, pre-migration `data-attr` literal for each of the thirteen entry-point
 * files (see the task brief's inventory table). None of these strings may
 * survive in the file that used to hardcode it — every one now reads its
 * label/data-attr from the shared registry above instead.
 */
const OLD_DATA_ATTR_BY_FILE: Record<string, string> = {
  "src/components/portal/pro-bookings.tsx": "bookings-settings-open",
  "src/components/portal/inspections-panel.tsx": "inspections-settings-open",
  "src/components/portal/pro-payments.tsx": "payments-settings-open",
  "src/components/portal/pro-leases.tsx": "leases-settings-open",
  "src/components/portal/pro-properties.tsx": "manager-properties-settings-open",
  "src/components/portal/pro-tours.tsx": "tours-settings-open",
  "src/components/portal/pro-applications.tsx": "application-settings-open",
  "src/components/portal/pro-background-checks.tsx": "background-check-settings-open",
  "src/components/portal/pro-task-list.tsx": "manager-task-automation-open",
  "src/components/portal/pro-all-services-panel.tsx": "services-settings-open",
  "src/components/portal/pro-vendors-panel.tsx": "manager-vendor-defaults-open",
  "src/components/portal/pro-residents.tsx": "residents-settings-open",
  "src/components/portal/resident-detail-subsection-chrome.tsx": "resident-detail-settings",
};

describe("settings entry-point migration sweep (node:fs)", () => {
  for (const [path, oldAttr] of Object.entries(OLD_DATA_ATTR_BY_FILE)) {
    it(`${path} no longer hardcodes the old "${oldAttr}" data-attr`, () => {
      const src = readFileSync(`${process.cwd()}/${path}`, "utf8");
      expect(src).not.toContain(oldAttr);
    });
  }
});
