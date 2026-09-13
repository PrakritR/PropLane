import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";

export function vendorCatalogProjection(row: ManagerVendorRow, managerUserId: string): ManagerVendorRow {
  return {
    id: row.id,
    managerUserId,
    name: row.name,
    trade: row.trade ?? "",
    trades: row.trades,
    phone: row.phone ?? "",
    email: row.email ?? "",
    notes: "",
    active: row.active !== false,
    sharedWithManagers: row.sharedWithManagers === true,
  };
}
