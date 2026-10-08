/**
 * Vendor Settings pages — the one list the Settings rail, the mobile home and
 * every list-band gear read (approved plan vendor-portal-redesign-1006). The
 * rail is grouped like the manager's Settings: Profile · Business · Money ·
 * Communication. Ids are the `?tab=` values; `messaging` and `payouts` keep
 * their old ids because emailed links and the setup banners already use them.
 */

export type VendorSettingsPageId =
  | "profile"
  | "security"
  | "business"
  | "capabilities"
  | "licenses"
  | "ai-info"
  | "integrations"
  | "payouts"
  | "invoicing"
  | "messaging"
  | "quick-replies"
  | "work-number-email"
  | "preferences"
  | "feedback"
  | "account";

export type VendorSettingsRailGroup = {
  label: "Profile" | "Business" | "Money" | "Communication";
  pages: { id: VendorSettingsPageId; label: string }[];
};

export const VENDOR_SETTINGS_RAIL: readonly VendorSettingsRailGroup[] = [
  {
    label: "Profile",
    pages: [
      { id: "profile", label: "Profile" },
      { id: "security", label: "Login & security" },
      { id: "preferences", label: "Preferences" },
      { id: "feedback", label: "Feedback" },
      { id: "account", label: "Account" },
    ],
  },
  {
    label: "Business",
    pages: [
      { id: "business", label: "Business details" },
      { id: "capabilities", label: "Trades & service area" },
      { id: "licenses", label: "Licenses & insurance" },
      { id: "ai-info", label: "AI info" },
      { id: "integrations", label: "Integrations" },
    ],
  },
  {
    label: "Money",
    pages: [
      { id: "payouts", label: "Payouts" },
      { id: "invoicing", label: "Invoicing" },
    ],
  },
  {
    label: "Communication",
    pages: [
      { id: "messaging", label: "Phone & notifications" },
      { id: "quick-replies", label: "Quick replies" },
      { id: "work-number-email", label: "Work number & email" },
    ],
  },
] as const;

/**
 * Old `?tab=` ids that must keep resolving after the regroup — Work contact &
 * email folded into Business details, Notifications into Phone & notifications,
 * Workspace access (removed earlier) onto Business details.
 */
export const VENDOR_SETTINGS_TAB_ALIASES: Record<string, VendorSettingsPageId> = {
  work: "business",
  "work-contacts": "business",
  "work-number": "business",
  "work-email": "business",
  workspaces: "business",
  "workspace-access": "business",
  notifications: "messaging",
};

/**
 * Settings pages that moved to another section. The old `?tab=` link lands on the new place, not on
 * the Settings home. Availability is the Calendar's Weekly hours pop-up.
 */
export const VENDOR_SETTINGS_MOVED_TABS: Record<string, string> = {
  availability: "/calendar?modal=weekly-hours",
};

/** Where an old Settings tab now lives (`/vendor/calendar?modal=weekly-hours`), or null if it did not move. */
export function vendorSettingsMovedHref(raw: string | null | undefined, basePath = "/vendor"): string | null {
  const target = raw ? (Object.hasOwn(VENDOR_SETTINGS_MOVED_TABS, raw) ? VENDOR_SETTINGS_MOVED_TABS[raw] : undefined) : undefined;
  return target ? `${basePath}${target}` : null;
}

export function resolveVendorSettingsTab(raw: string | null | undefined): VendorSettingsPageId | null {
  if (!raw) return null;
  const aliased = VENDOR_SETTINGS_TAB_ALIASES[raw] ?? raw;
  const known = VENDOR_SETTINGS_RAIL.some((group) => group.pages.some((page) => page.id === aliased));
  return known ? (aliased as VendorSettingsPageId) : null;
}

/** The gear in each vendor list band opens the matching Settings page — never a local pop-up. */
export const VENDOR_LIST_GEAR_TARGETS = {
  services: "capabilities", // Trades & service area
  payments: "payouts", // Payouts
  reviews: "profile", // Profile
  communication: "quick-replies", // Quick replies
} as const satisfies Record<string, VendorSettingsPageId>;

export type VendorListGearSection = keyof typeof VENDOR_LIST_GEAR_TARGETS;

export function vendorSettingsHref(page: VendorSettingsPageId, basePath = "/vendor"): string {
  return `${basePath}/profile?tab=${page}`;
}

export function vendorListGearHref(section: VendorListGearSection, basePath = "/vendor"): string {
  return vendorSettingsHref(VENDOR_LIST_GEAR_TARGETS[section], basePath);
}

export function vendorSettingsPageLabel(page: VendorSettingsPageId): string {
  for (const group of VENDOR_SETTINGS_RAIL) {
    const hit = group.pages.find((p) => p.id === page);
    if (hit) return hit.label;
  }
  return "Settings";
}
