import type { ManagerPortalSettingsTab } from "@/components/portal/pro-portal-settings-modal";

/**
 * Single source of truth for every settings gear across the manager portal.
 *
 * Thirteen call sites used to each hand-roll their own icon-button label and
 * `data-attr`, while the dialog those buttons opened computed its own title
 * separately (via `ManagerPortalSettingsModal`'s `scopedTitle` prop, or a
 * hardcoded title inside a standalone modal). The two were never tied
 * together, so a button could say "Property settings" and open a dialog
 * titled "Applications settings" with nobody noticing.
 *
 * Every module here is authored ONCE as a `label`, which doubles as the
 * dialog title (`dialogTitle` is just `label` again) — there is no second
 * string to keep in sync. Read an entry with `getSettingsEntryPoint`, pass
 * `entry.label` to the trigger button, `entry.dataAttr` to its `data-attr`,
 * and `settingsDialogTitlePrefix(entry)` to `scopedTitle` on
 * `ManagerPortalSettingsModal` (it appends " settings" itself, so the prefix
 * — not the full label — goes there). Changing an entry's wording changes
 * both the button and the dialog; there is no path to changing only one.
 */
export interface ManagerSettingsEntryPoint {
  /** Stable slug: this registry's key, and the suffix of `dataAttr`. */
  readonly id: string;
  /**
   * The `ManagerPortalSettingsTab` this entry opens, when it opens the
   * shared `ManagerPortalSettingsModal`. Undefined for a module with its own
   * standalone settings dialog (background checks, vendor defaults) or for
   * the generic resident-detail fallback, which does not own one fixed tab.
   */
  readonly tab?: ManagerPortalSettingsTab;
  /** Icon-button label, e.g. "Booking settings". */
  readonly label: string;
  /** Dialog title. Always identical to `label` — same string, not a second one authored to match it. */
  readonly dialogTitle: string;
  /** `data-attr` for the trigger, always `settings-open-<id>`. */
  readonly dataAttr: string;
}

function entryPoint(
  id: string,
  label: string,
  tab?: ManagerPortalSettingsTab,
): ManagerSettingsEntryPoint {
  return { id, tab, label, dialogTitle: label, dataAttr: `settings-open-${id}` };
}

/**
 * Every settings module's entry, keyed by a stable id used elsewhere in this
 * file (`getSettingsEntryPoint`, `getSettingsEntryPointForTab`) and by
 * callers that want a specific module rather than a tab lookup.
 */
export const MANAGER_SETTINGS_ENTRY_POINTS = {
  bookings: entryPoint("bookings", "Booking settings", "bookings"),
  inspections: entryPoint("inspections", "Inspection settings", "inspections"),
  payments: entryPoint("payments", "Payment settings", "payments"),
  leases: entryPoint("leases", "Lease settings", "lease"),
  properties: entryPoint("properties", "Property settings"),
  applications: entryPoint("applications", "Application settings", "applications"),
  tours: entryPoint("tours", "Tour settings", "tours"),
  // No `ManagerPortalSettingsTab` fits this — background checks are a
  // separate `ManagerScreeningSettingsModal`, not a tab on the shared modal.
  backgroundChecks: entryPoint("background-checks", "Background check settings"),
  tasks: entryPoint("tasks", "Task settings", "tasks"),
  services: entryPoint("services", "Service settings", "services"),
  // Opens `ManagerVendorDefaultsModal`, a separate standalone dialog, not a
  // `ManagerPortalSettingsTab` — "settings" was never the right word here
  // either, this module has only ever had defaults, not a settings tab.
  vendors: entryPoint("vendors", "Vendor defaults"),
  residents: entryPoint("residents", "Resident settings", "resident"),
  // Reminder matrix plus quiet hours. The tab id stays `automation`; the hub
  // query and rail label are `reminders` so this does not collide with Account
  // Notifications.
  notifications: entryPoint("notifications", "Reminder settings", "automation"),
  // Every other section has a settings gear; Communication did not. This
  // entry is what that new gear (in `pro-communication.tsx`) opens.
  communication: entryPoint("communication", "Communication settings", "communication"),
  vendorServices: entryPoint("vendor-services", "Service settings"),
  vendorCalendar: entryPoint("vendor-calendar", "Calendar settings"),
  vendorCommunication: entryPoint("vendor-communication", "Communication settings"),
  /**
   * The generic default for `ResidentDetailSubsectionChrome`'s Settings
   * action when a caller does not resolve a specific module (e.g. the
   * resident-detail Tours subsection, wired through a component this
   * registry's callers do not own — see the module's own file for detail).
   * Not one of the twelve real settings modules above; kept so every
   * `data-attr` in the portal — including this fallback — still matches the
   * one `settings-open-<module>` scheme instead of carrying its own
   * one-off name.
   */
  residentDetail: entryPoint("resident-detail", "Settings"),
} as const satisfies Record<string, ManagerSettingsEntryPoint>;

export type ManagerSettingsModuleId = keyof typeof MANAGER_SETTINGS_ENTRY_POINTS;

/** Look up an entry by its registry key. */
export function getSettingsEntryPoint(id: ManagerSettingsModuleId): ManagerSettingsEntryPoint {
  return MANAGER_SETTINGS_ENTRY_POINTS[id];
}

/**
 * Look up the entry that opens a given `ManagerPortalSettingsTab`, for a
 * caller that only knows which tab it is about to open (e.g. a shared modal
 * instance reused across several resident-detail subsections). Falls back to
 * the generic resident-detail entry only for a tab with no dedicated entry
 * point at all — every current `ManagerPortalSettingsTab` value
 * has its own gear today (`communication` and `automation`/`notifications`
 * included); the fallback exists for defensiveness, not because any current
 * tab still needs it.
 */
export function getSettingsEntryPointForTab(
  tab: ManagerPortalSettingsTab,
): ManagerSettingsEntryPoint {
  const match = Object.values(MANAGER_SETTINGS_ENTRY_POINTS).find((item) => item.tab === tab);
  return match ?? MANAGER_SETTINGS_ENTRY_POINTS.residentDetail;
}

/**
 * `ManagerPortalSettingsModal`'s `scopedTitle` prop is a prefix — the modal
 * appends " settings" itself (`${scopedTitle} settings`). Passing the full
 * `dialogTitle` there would double up ("Booking settings settings"), and
 * hand-stripping the suffix at each call site would reintroduce exactly the
 * copy-drift risk this module exists to remove. Use this instead.
 */
export function settingsDialogTitlePrefix(entry: ManagerSettingsEntryPoint): string {
  return entry.dialogTitle.replace(/ settings$/i, "");
}

/**
 * Payments settings open from two different direction pages — incoming rent
 * reminders and outgoing payee reminders — and the dialog has always used a
 * different title for each ("Payments settings" vs "Outgoing payments
 * settings") while the button never did. Both now come from one `label` per
 * direction so they cannot drift from each other either.
 */
export function getPaymentsSettingsEntryPoint(
  direction: "incoming" | "outgoing",
): ManagerSettingsEntryPoint {
  const base = MANAGER_SETTINGS_ENTRY_POINTS.payments;
  if (direction !== "outgoing") return base;
  const label = "Outgoing payment settings";
  return { ...base, label, dialogTitle: label };
}
