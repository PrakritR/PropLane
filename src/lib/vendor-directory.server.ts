import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AxisCatalogVendor } from "@/lib/axis-vendor-catalog";

type DirectoryRow = {
  user_id: string;
  business_name: string | null;
  service_area: string | null;
  service_area_zips: string[] | null;
  trades: string[] | null;
  license_number: string | null;
  insurance_expires_at: string | null;
  insurance_doc_path: string | null;
};

const DIRECTORY_COLUMNS =
  "user_id, business_name, service_area, service_area_zips, trades, license_number, insurance_expires_at, insurance_doc_path";

function insuranceIsCurrent(row: DirectoryRow): boolean {
  if (!row.insurance_doc_path) return false;
  if (!row.insurance_expires_at) return true;
  return row.insurance_expires_at >= new Date().toISOString().slice(0, 10);
}

/**
 * Manager-safe projection of a directory-listed self-serve vendor — ONLY
 * business name, trades, service area, and insured/licensed flags. Never
 * policy numbers, doc paths, or contact info: those stay private until the
 * manager actually links the vendor onto their own roster (mirrors the same
 * `directory_listed`-gated privacy boundary as
 * `20260912230000_vendor_directory_private_fields.sql`).
 */
function toCatalogRow(row: DirectoryRow): AxisCatalogVendor {
  const trades = Array.isArray(row.trades) ? row.trades : [];
  const zips = Array.isArray(row.service_area_zips) ? row.service_area_zips : [];
  const city = (row.service_area ?? "").trim() || (zips.length ? zips.join(", ") : "");
  return {
    catalogId: `self-serve-${row.user_id}`,
    name: (row.business_name ?? "").trim() || "PropLane vendor",
    trade: trades[0] ?? "",
    trades,
    city,
    zip: zips[0] ?? "",
    phone: "",
    email: "",
    description: [trades.join(", "), city].filter(Boolean).join(" · "),
    hourlyCents: null,
    serviceCents: null,
    directoryVendorUserId: row.user_id,
    insured: insuranceIsCurrent(row),
    licensed: Boolean((row.license_number ?? "").trim()),
  };
}

export async function loadDirectoryListedVendors(
  db: SupabaseClient,
  filter?: { trade?: string; area?: string },
): Promise<AxisCatalogVendor[]> {
  let query = db
    .from("vendor_business_profiles")
    .select(DIRECTORY_COLUMNS)
    .eq("directory_listed", true)
    .not("onboarding_completed_at", "is", null)
    .order("business_name", { ascending: true })
    .limit(200);

  const trade = filter?.trade?.trim();
  if (trade) query = query.contains("trades", [trade]);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let rows = ((data ?? []) as DirectoryRow[]).map(toCatalogRow);

  const area = filter?.area?.trim().toLowerCase();
  if (area) {
    rows = rows.filter((row) => row.city.toLowerCase().includes(area) || row.zip.includes(area));
  }
  return rows;
}
