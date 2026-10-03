import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkOrderCategory } from "@/lib/work-order-taxonomy";
import { vendorCapabilitiesMatchCategory, vendorTradeMatchesCategory } from "@/lib/work-order-taxonomy";
import { propertyMatchesZipRadius, parseUSZip } from "@/lib/listings-search";
import { vendorInsuranceIsCurrent } from "@/lib/vendor-business-profile.server";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

type DirectoryProfileRow = {
  user_id: string;
  trades: string[] | null;
  service_area_zips: string[] | null;
  service_radius_miles: number | null;
  license_number: string | null;
  insurance_expires_at: string | null;
  insurance_doc_path: string | null;
  directory_listed: boolean | null;
  onboarding_completed_at: string | null;
};

const PROFILE_COLUMNS =
  "user_id, trades, service_area_zips, service_radius_miles, license_number, insurance_expires_at, insurance_doc_path, directory_listed, onboarding_completed_at";

export function extractZipFromAddress(address?: string | null): string | null {
  const raw = address?.trim();
  if (!raw) return null;
  const match = raw.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1]! : null;
}

export function workOrderCategoryForMarketplace(
  row: Pick<DemoManagerWorkOrderRow, "category">,
  tradeLabel: string,
): WorkOrderCategory | null {
  if (row.category) return row.category;
  const normalized = tradeLabel.trim();
  const pairs: [string, WorkOrderCategory][] = [
    ["plumbing", "plumbing"],
    ["electrical", "electrical"],
    ["hvac", "hvac"],
    ["appliance", "appliance"],
    ["cleaning", "cleaning"],
    ["access", "access"],
    ["lock", "access"],
    ["general", "general"],
    ["maintenance", "general"],
  ];
  const hay = normalized.toLowerCase();
  for (const [needle, category] of pairs) {
    if (hay.includes(needle)) return category;
  }
  if (vendorTradeMatchesCategory(normalized, "plumbing")) return "plumbing";
  return null;
}

function vendorMatchesZip(
  propertyZip: string,
  publishRadiusMi: number,
  profile: DirectoryProfileRow,
): boolean {
  const zips = Array.isArray(profile.service_area_zips) ? profile.service_area_zips.filter(Boolean) : [];
  const vendorRadius = profile.service_radius_miles ?? publishRadiusMi;
  const effectiveRadius = Math.min(Math.max(1, publishRadiusMi), Math.max(1, vendorRadius));
  if (zips.length === 0) {
    return propertyMatchesZipRadius(propertyZip, propertyZip, effectiveRadius);
  }
  return zips.some((zip) => propertyMatchesZipRadius(propertyZip, zip, effectiveRadius));
}

function vendorIsEligible(profile: DirectoryProfileRow): boolean {
  if (profile.directory_listed !== true || !profile.onboarding_completed_at) return false;
  if (!(profile.license_number ?? "").trim()) return false;
  return vendorInsuranceIsCurrent({
    insuranceDocPath: profile.insurance_doc_path,
    insuranceExpiresAt: profile.insurance_expires_at,
  });
}

export function filterMarketplaceVendorUserIds(
  profiles: DirectoryProfileRow[],
  input: { propertyZip: string; publishRadiusMi: number; category: WorkOrderCategory },
): string[] {
  const propertyZip = parseUSZip(input.propertyZip);
  if (propertyZip === null) return [];

  const out: string[] = [];
  for (const profile of profiles) {
    if (!vendorIsEligible(profile)) continue;
    const trades = Array.isArray(profile.trades) ? profile.trades : [];
    if (!vendorCapabilitiesMatchCategory(trades, input.category)) continue;
    const zipRaw = String(propertyZip).padStart(5, "0");
    if (!vendorMatchesZip(zipRaw, input.publishRadiusMi, profile)) continue;
    out.push(profile.user_id);
  }
  return out;
}

export async function loadMarketplaceVendorUserIds(
  db: SupabaseClient,
  input: { propertyZip: string; publishRadiusMi: number; category: WorkOrderCategory },
): Promise<string[]> {
  const { data, error } = await db
    .from("vendor_business_profiles")
    .select(PROFILE_COLUMNS)
    .eq("directory_listed", true)
    .not("onboarding_completed_at", "is", null)
    .limit(500);
  if (error) throw new Error(error.message);
  return filterMarketplaceVendorUserIds((data ?? []) as DirectoryProfileRow[], input);
}

export async function resolveWorkOrderPropertyZip(
  db: SupabaseClient,
  row: DemoManagerWorkOrderRow,
): Promise<string | null> {
  const fromAddress = extractZipFromAddress(row.propertyAddress);
  if (fromAddress) return fromAddress;
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim();
  if (!propertyId) return null;
  const { data } = await db
    .from("manager_property_records")
    .select("row_data")
    .eq("id", propertyId)
    .maybeSingle();
  const rowData = (data?.row_data ?? {}) as { zip?: string; address?: string; submission?: { zip?: string } };
  const zip =
    rowData.zip?.trim() ||
    rowData.submission?.zip?.trim() ||
    extractZipFromAddress(rowData.address);
  return zip || null;
}
