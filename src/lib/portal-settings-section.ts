import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

/**
 * The ONE list of every manager settings module — used to drive the tab
 * switcher inside `ProPortalSettingsModal` and this file's own area parser.
 * There used to be a second, private copy of this list hardcoded inside
 * `pro-portal-settings-modal.tsx`; that file now imports it from here so a
 * new module (or a renamed one) is authored once.
 *
 * The `id` is the same string as `ManagerPortalSettingsTab`, NOT
 * `settings-entry-points.ts`'s own kebab `id` field (which disagrees for a
 * couple of modules — "leases" vs the tab "lease", "residents" vs "resident").
 * Old `/portal/settings/<id>` URLs redirect onto Profile via
 * `resolveSettingsRedirectHubTab`.
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
  // Reminder matrix, quiet hours, and (C111/C116) every area's reminder
  // rules and automated messages, including Bookings' and Inspections' —
  // both former tabs held only that content and are gone. The tab id stays
  // `automation` (the `ManagerPortalSettingsTab` union value). The hub query
  // is `reminders`.
  { id: "automation", label: "Reminders" },
];

/**
 * Bare `/portal/settings` redirects to Profile → Applications — Properties
 * is no longer a settings module (house rules live on the listing; the
 * Property bar scopes every other module).
 */
export const DEFAULT_MANAGER_SETTINGS_TAB: ManagerPortalSettingsTab = "applications";

/** Resolves a raw `/portal/settings/<area>` URL segment (or a leftover `?tab=`) to a real tab, or `null` for an unknown one. */
export function parseManagerSettingsAreaTab(area: string | undefined | null): ManagerPortalSettingsTab | null {
  if (!area) return null;
  if (area === "leases") return "lease";
  if (area === "reminders") return "automation";
  if (area === "residents") return "resident";
  if (area === "properties") return "applications";
  // Bookings and Inspections settings tabs are gone (C111/C116) — both held
  // only a Reminders/Messages section, which now lives on the Reminders hub.
  // An old bookmark or link to either segment lands there instead of 404ing.
  if (area === "bookings" || area === "inspections") return "automation";
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

/** Profile hub path for a gear-modal tab. */
export function managerSettingsProfilePath(
  tab: ManagerPortalSettingsTab | null | undefined,
  basePath = "/portal",
): string {
  return `${basePath}/profile?tab=${managerSettingsHubTab(tab)}`;
}

/**
 * Profile `?tab=` for an old `/portal/settings` path segment or query.
 * Empty/missing → Applications. Unknown → `null` (caller 404s).
 * `plan` is the listing-wizard upgrade alias for Billing.
 */
export function resolveSettingsRedirectHubTab(raw: string | null | undefined): string | null {
  if (!raw) return managerSettingsHubTab(DEFAULT_MANAGER_SETTINGS_TAB);
  if (raw === "plan") return "billing";
  const parsed = parseManagerSettingsAreaTab(raw);
  if (!parsed) return null;
  return managerSettingsHubTab(parsed);
}
