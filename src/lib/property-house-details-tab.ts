const STORAGE_PREFIX = "property-house-details-tab:";

export type HouseDetailsTabId = "rooms" | "baths" | "spaces" | "house" | "info" | "manager";

export function readHouseDetailsTab(propertyId: string, fallback: HouseDetailsTabId): HouseDetailsTabId {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${propertyId}`);
  if (raw === "rooms" || raw === "baths" || raw === "spaces" || raw === "house" || raw === "info" || raw === "manager") return raw;
  return fallback;
}

export function writeHouseDetailsTab(propertyId: string, tab: HouseDetailsTabId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(`${STORAGE_PREFIX}${propertyId}`, tab);
}
