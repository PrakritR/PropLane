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
