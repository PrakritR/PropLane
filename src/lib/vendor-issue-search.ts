/**
 * Filter own vendors + the shared PropLane catalog by issue/trade and the
 * checked property ZIPs. Pure — nothing is persisted here. Checking a hit in
 * the Add vendor workspace is what creates a row.
 */

import {
  AXIS_VENDOR_CATALOG,
  managerOwnsCatalogVendor,
  vendorCatalogEntryMatchesQuery,
  type AxisCatalogVendor,
} from "@/lib/axis-vendor-catalog";

export type VendorIssueSearchSource = "roster" | "catalog" | "online";

export type VendorIssueSearchHit = {
  source: VendorIssueSearchSource;
  id: string;
  name: string;
  trade: string;
  phone: string;
  city: string;
  zip: string;
  alreadyOwned: boolean;
  email?: string;
  description?: string;
  hourlyCents?: number | null;
  serviceCents?: number | null;
};

export type VendorIssueSearchRosterRow = {
  id: string;
  name: string;
  trade: string;
  phone?: string;
  city?: string;
  zip?: string;
  email?: string;
  notes?: string;
};

/** Empty `selectedIds` means every property (the vendor `propertyIds` contract). */
export function zipsForSelectedProperties(
  properties: readonly { id: string; zip?: string }[],
  selectedIds: readonly string[],
): string[] {
  const scoped =
    selectedIds.length === 0 ? properties : properties.filter((row) => selectedIds.includes(row.id));
  const zips: string[] = [];
  const seen = new Set<string>();
  for (const row of scoped) {
    const zip = (row.zip ?? "").trim();
    if (!zip || seen.has(zip)) continue;
    seen.add(zip);
    zips.push(zip);
  }
  return zips;
}

function zipPrefix(zip: string): string {
  return zip.replace(/\D/g, "").slice(0, 3);
}

function zipNear(candidateZip: string, propertyZips: readonly string[]): boolean {
  if (propertyZips.length === 0) return true;
  const needle = zipPrefix(candidateZip);
  if (!needle) return true;
  return propertyZips.some((zip) => {
    const prefix = zipPrefix(zip);
    return Boolean(prefix) && (candidateZip.replace(/\D/g, "").startsWith(prefix) || prefix.startsWith(needle));
  });
}

function matchesIssue(
  fields: { name: string; trade: string; city?: string; zip?: string; email?: string; phone?: string; notes?: string },
  issue: string,
): boolean {
  if (!issue.trim()) return true;
  return vendorCatalogEntryMatchesQuery(fields, issue);
}

export function filterVendorsForIssue(input: {
  issue: string;
  propertyZips: readonly string[];
  roster: readonly VendorIssueSearchRosterRow[];
  catalog?: readonly AxisCatalogVendor[];
}): { roster: VendorIssueSearchHit[]; catalog: VendorIssueSearchHit[] } {
  const catalog = input.catalog ?? AXIS_VENDOR_CATALOG;
  const rosterHits: VendorIssueSearchHit[] = [];
  for (const row of input.roster) {
    if (!matchesIssue(row, input.issue)) continue;
    if (!zipNear(row.zip ?? "", input.propertyZips)) continue;
    rosterHits.push({
      source: "roster",
      id: row.id,
      name: row.name,
      trade: row.trade,
      phone: row.phone ?? "",
      city: row.city ?? "",
      zip: row.zip ?? "",
      alreadyOwned: true,
    });
  }

  const owned = input.roster.map((row) => ({ name: row.name, trade: row.trade }));
  const catalogHits: VendorIssueSearchHit[] = [];
  for (const row of catalog) {
    if (managerOwnsCatalogVendor(owned, row.name, row.trade)) continue;
    if (!matchesIssue(row, input.issue)) continue;
    if (!zipNear(row.zip, input.propertyZips)) continue;
    catalogHits.push({
      source: "catalog",
      id: row.catalogId,
      name: row.name,
      trade: row.trade,
      phone: row.phone,
      city: row.city,
      zip: row.zip,
      alreadyOwned: false,
      email: row.email,
      description: row.description,
      hourlyCents: row.hourlyCents,
      serviceCents: row.serviceCents,
    });
  }

  return { roster: rosterHits, catalog: catalogHits };
}

/** Directory rows for the Online list — name, trade, phone, city only. No photos. */
export function onlineDirectoryHits(input: {
  issue: string;
  propertyZips: readonly string[];
  catalog?: readonly AxisCatalogVendor[];
}): Array<Pick<VendorIssueSearchHit, "id" | "name" | "trade" | "phone" | "city">> {
  const catalog = input.catalog ?? AXIS_VENDOR_CATALOG;
  return catalog
    .filter((row) => matchesIssue(row, input.issue) && zipNear(row.zip, input.propertyZips))
    .map((row) => ({
      id: row.catalogId,
      name: row.name,
      trade: row.trade,
      phone: row.phone,
      city: row.city,
    }));
}
