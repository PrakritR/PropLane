import { type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { expandTypicalRateCells, findRosterCatalogMatch } from "@/lib/manager-vendor-typical-rates";
import {
  makeVendorId,
  persistManagerVendorToServer,
  upsertManagerVendor,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";

/** Persist a PropLane catalog vendor onto this manager's roster, or reuse the existing match. */
export async function ensureCatalogVendorOnRoster(input: {
  userId: string;
  catalog: AxisCatalogVendor;
  existing: readonly ManagerVendorRow[];
  propertyIds?: string[];
}): Promise<ManagerVendorRow | null> {
  const match = findRosterCatalogMatch(input.existing, input.catalog);
  if (match) return match;
  const trade = input.catalog.trade.trim();
  const now = new Date().toISOString();
  const propertyIds = input.propertyIds?.filter((id) => id.trim()) ?? [];
  const row: ManagerVendorRow = {
    id: makeVendorId(),
    managerUserId: input.userId,
    name: input.catalog.name.trim(),
    trade: trade || input.catalog.name.trim(),
    trades: trade ? [trade] : undefined,
    phone: input.catalog.phone.trim(),
    email: input.catalog.email.trim(),
    notes: input.catalog.description.trim(),
    active: true,
    catalogId: input.catalog.catalogId,
    propertyIds: propertyIds.length ? propertyIds : undefined,
    typicalRates: expandTypicalRateCells({
      propertyIds,
      trades: trade ? [trade] : [],
      existing: [],
      fallback:
        input.catalog.hourlyCents != null && input.catalog.serviceCents != null
          ? { hourlyCents: input.catalog.hourlyCents, serviceCents: input.catalog.serviceCents }
          : undefined,
    }),
    createdAt: now,
    updatedAt: now,
  };
  if (!(await persistManagerVendorToServer(row))) return null;
  upsertManagerVendor(row, input.userId, { persist: false });
  return row;
}
