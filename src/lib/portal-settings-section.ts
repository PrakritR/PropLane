import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

/**
 * The ONE list of every manager settings module — used to drive the tab
 * switcher inside `ProPortalSettingsModal`, the `/portal/settings/<tab>`
 * section route's nav rail, and this file's own area parser. There used to
 * be a second, private copy of this list hardcoded inside
 * `pro-portal-settings-modal.tsx`; that file now imports it from here so a
 * new module (or a renamed one) is authored once.
 *
 * The `id` doubles as the `/portal/settings/<id>` URL segment. It is
 * deliberately the same string as `ManagerPortalSettingsTab`, NOT
 * `settings-entry-points.ts`'s own kebab `id` field (which disagrees for a
 * couple of modules — "leases" vs the tab "lease", "residents" vs "resident")
 * — introducing a second id-to-tab translation table would be more surface
 * area to keep in sync, not less, for a module set that is otherwise a
 * strict subset of the settings-entry-points registry anyway.
 *
 * Hub `?tab=` ids can differ: automation → reminders, communication → messaging.
 */
export const MANAGER_PORTAL_SETTINGS_TABS: readonly { id: ManagerPortalSettingsTab; label: string }[] = [
  { id: "applications", label: "Applications" },
  // Renamed from "Calendar" (AXI-161): every control on this panel is a TOUR
  // setting — notice required, auto-confirm, tour reminders — so calling it
  // Calendar sent a manager looking for tour rules to the wrong tab, and one
  // looking for calendar rules to a tab that has none.
  { id: "tours", label: "Tours" },
  { id: "lease", label: "Lease" },
  { id: "tasks", label: "Tasks" },
  { id: "resident", label: "Residents" },
  { id: "payments", label: "Payments" },
  { id: "payouts", label: "Payouts" },
  { id: "services", label: "Services" },
  { id: "communication", label: "Communication" },
  { id: "bookings", label: "Bookings" },
  { id: "inspections", label: "Inspections" },
  // Reminder matrix + quiet hours. The tab id stays `automation` (the
  // `ManagerPortalSettingsTab` union value). The hub query is `reminders`.
  { id: "automation", label: "Reminders" },
];

/**
 * Bare `/portal/settings` lands on Applications — Properties is no longer a
 * settings module (house rules live on the listing; the Property bar scopes
 * every other module).
 */
export const DEFAULT_MANAGER_SETTINGS_TAB: ManagerPortalSettingsTab = "applications";

/** Resolves a raw `/portal/settings/<area>` URL segment to a real tab, or `null` for an unknown one. */
export function parseManagerSettingsAreaTab(area: string | undefined | null): ManagerPortalSettingsTab | null {
  if (!area) return null;
  if (area === "leases") return "lease";
  if (area === "reminders") return "automation";
  if (area === "residents") return "resident";
  if (area === "properties") return "applications";
  const match = MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === area);
  return match ? match.id : null;
}

/**
 * Main Settings `?tab=` for a module. Communication folds into the existing
 * messaging pane; the reminder matrix is `reminders` so it does not collide
 * with Account Notifications.
 */
export function managerSettingsHubTab(tab: ManagerPortalSettingsTab | null | undefined): string {
  if (!tab || tab === "properties") return "applications";
  if (tab === "automation") return "reminders";
  if (tab === "communication") return "messaging";
  return tab;
}
