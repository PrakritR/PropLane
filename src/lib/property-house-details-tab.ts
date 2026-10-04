const STORAGE_PREFIX = "property-house-details-tab:";

/** The five House details sub-tabs. Door card lives only in Promotion → Flyers & printables. */
export type HouseDetailsTabId = "rooms" | "baths" | "spaces" | "house" | "residents";

const TAB_IDS: ReadonlySet<string> = new Set(["rooms", "baths", "spaces", "house", "residents"]);

/**
 * Old sub-tab ids still land somewhere sensible: "info" (Residents read this)
 * is now "residents"; "manager" (Manager tools) is gone, its notes moved into
 * "house" and its handouts into "residents". Anything unknown is null.
 */
const TAB_ALIASES: Readonly<Record<string, HouseDetailsTabId>> = {
  info: "residents",
  "for-residents": "residents",
  manager: "house",
  "manager-tools": "house",
  "door-card": "house",
  printables: "residents",
  bathrooms: "baths",
  "shared-spaces": "spaces",
};

export function resolveHouseDetailsTab(raw: string | null | undefined): HouseDetailsTabId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (TAB_IDS.has(key)) return key as HouseDetailsTabId;
  return TAB_ALIASES[key] ?? null;
}

export function readHouseDetailsTab(propertyId: string, fallback: HouseDetailsTabId): HouseDetailsTabId {
  if (typeof window === "undefined") return fallback;
  return resolveHouseDetailsTab(window.localStorage.getItem(`${STORAGE_PREFIX}${propertyId}`)) ?? fallback;
}

export function writeHouseDetailsTab(propertyId: string, tab: HouseDetailsTabId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${STORAGE_PREFIX}${propertyId}`, tab);
}
