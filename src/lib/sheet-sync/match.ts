import {
  AMBIKA_MANAGER_EMAIL,
  AMBIKA_SEATTLE_PROPERTY_IDS,
  isLockedLiveListingId,
  type SeattleHouse,
} from "@/lib/ambika-seattle-occupancy";
import { AMBIKA_SALES_SPREADSHEET_ID } from "@/lib/manager-sheet-link";
import { listingMatchesHouseKey } from "@/lib/sheet-sync/house-key";

export function resolveSheetPropertyId(
  houseKey: string,
  properties: Array<{ id: string; address?: string; title?: string; buildingName?: string }>,
  opts?: { managerEmail?: string | null; spreadsheetId?: string | null },
): string | null {
  const ambikaBook =
    opts?.spreadsheetId === AMBIKA_SALES_SPREADSHEET_ID ||
    opts?.managerEmail?.trim().toLowerCase() === AMBIKA_MANAGER_EMAIL;
  if (ambikaBook && houseKey in AMBIKA_SEATTLE_PROPERTY_IDS) {
    return AMBIKA_SEATTLE_PROPERTY_IDS[houseKey as SeattleHouse];
  }
  const match = properties.find((property) => listingMatchesHouseKey(houseKey, property));
  return match?.id ?? null;
}

export function assertWritableSheetPropertyId(propertyId: string): string | null {
  if (isLockedLiveListingId(propertyId)) {
    return `Refused locked live listing ${propertyId}.`;
  }
  return null;
}

export function filterSheetPropertyMap<T extends { id: string }>(
  propertyByHouse: Map<string, T>,
  allowedIds: Set<string> | null,
): Map<string, T> {
  if (!allowedIds) return propertyByHouse;
  const next = new Map<string, T>();
  for (const [houseKey, property] of propertyByHouse) {
    if (allowedIds.has(property.id)) next.set(houseKey, property);
  }
  return next;
}
