import { AXIS_VENDOR_CATALOG, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { isVendorCategorySettingsRow, type ManagerVendorRow } from "@/lib/manager-vendors-storage";

function sameCatalogIdentity(a: Pick<AxisCatalogVendor, "catalogId" | "name" | "trade">, b: Pick<AxisCatalogVendor, "catalogId" | "name" | "trade">): boolean {
  if (a.catalogId && b.catalogId && a.catalogId === b.catalogId) return true;
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase()
    && a.trade.trim().toLowerCase() === b.trade.trim().toLowerCase();
}

function rosterToCatalogRow(row: ManagerVendorRow): AxisCatalogVendor {
  return {
    catalogId: row.catalogId?.trim() || `shared-${row.id}`,
    name: row.name,
    trade: row.trade,
    city: "",
    zip: "",
    phone: row.phone,
    email: row.email,
    description: row.notes.trim() || row.trade,
    hourlyCents: row.typicalRates?.[0]?.hourlyCents ?? 0,
    serviceCents: row.typicalRates?.[0]?.serviceCents ?? 0,
  };
}

/** Curated PropLane catalog plus this manager’s vendors marked Share on PropLane. */
export function listManagerCatalogVendors(roster: readonly ManagerVendorRow[]): AxisCatalogVendor[] {
  const out = [...AXIS_VENDOR_CATALOG];
  for (const row of roster) {
    if (row.shareOnProplane !== true || isVendorCategorySettingsRow(row)) continue;
    const mapped = rosterToCatalogRow(row);
    if (out.some((existing) => sameCatalogIdentity(existing, mapped))) continue;
    out.push(mapped);
  }
  return out;
}

/**
 * The "PropLane vendors" tab's trade/area Filter must narrow EVERY row it
 * renders, not just the self-serve directory rows the server already
 * pre-filters by the same params — a curated catalog row (or a shared-roster
 * row) with no matching trade must not survive the filter either
 * (proof-bug #2: HVAC/Electrical/Cleaning stayed visible with "Plumbing" selected).
 */
export function catalogVendorMatchesTradeArea(
  row: Pick<AxisCatalogVendor, "trade" | "trades" | "city" | "zip">,
  trade: string,
  area: string,
): boolean {
  if (trade) {
    const rowTrades = row.trades?.length ? row.trades : row.trade ? [row.trade] : [];
    if (!rowTrades.includes(trade)) return false;
  }
  const needle = area.trim().toLowerCase();
  if (needle && !(row.city.toLowerCase().includes(needle) || row.zip.includes(needle))) return false;
  return true;
}
