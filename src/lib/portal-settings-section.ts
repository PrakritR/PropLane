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
  { id: "services", label: "Services" },
  { id: "communication", label: "Communication" },
  { id: "bookings", label: "Bookings" },
  { id: "inspections", label: "Inspections" },
  // Renamed from "Automation": this module is the Notifications hub — the
  // reminder matrix plus manager alert routing and quiet hours — not a
  // generic "automation" catch-all. The tab id stays `automation` on
  // purpose: it is the `ManagerPortalSettingsTab` union value (owned by
  // `pro-portal-settings-modal.tsx`) and the live `/portal/settings/automation`
  // URL segment; renaming the id would either break that URL or require
  // editing a file this module does not own. See `settings-entry-points.ts`'s
  // `notifications` entry for the gear button's own label.
  { id: "automation", label: "Notifications" },
];

/**
 * Bare `/portal/settings` lands here. Applications is the modal's own
 * long-standing default (`initialTab = "applications"`), so a manager who
 * types the bare URL sees the same starting module they always got from the
 * old "global settings hub" variant of the dialog.
 */
export const DEFAULT_MANAGER_SETTINGS_TAB: ManagerPortalSettingsTab = "applications";

/** Resolves a raw `/portal/settings/<area>` URL segment to a real tab, or `null` for an unknown one. */
export function parseManagerSettingsAreaTab(area: string | undefined | null): ManagerPortalSettingsTab | null {
  if (!area) return null;
  const match = MANAGER_PORTAL_SETTINGS_TABS.find((item) => item.id === area);
  return match ? match.id : null;
}
