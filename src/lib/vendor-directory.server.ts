import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import { vendorInsuranceIsCurrent } from "@/lib/vendor-business-profile.server";
import { computeVendorReviewAggregate } from "@/lib/vendor-reviews";

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
  return vendorInsuranceIsCurrent({ insuranceDocPath: row.insurance_doc_path, insuranceExpiresAt: row.insurance_expires_at });
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
  filter?: { trade?: string; area?: string; minRating?: number },
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

  // Verified-only directory (C083/C198): only a vendor with a current license
  // AND a current (uploaded, non-expired) insurance certificate is
  // discoverable in the manager-facing directory — an unverified self-serve
  // vendor never appears here, even if they toggled directory_listed on.
  rows = rows.filter((row) => row.insured && row.licensed);

  const area = filter?.area?.trim().toLowerCase();
  if (area) {
    rows = rows.filter((row) => row.city.toLowerCase().includes(area) || row.zip.includes(area));
  }

  // Rating (average + count only — never raw review text) for every remaining
  // directory vendor, one batched vendor_reviews query rather than N+1.
  const vendorUserIds = rows
    .map((row) => row.directoryVendorUserId)
    .filter((id): id is string => Boolean(id));
  if (vendorUserIds.length > 0) {
    const { data: reviewRows, error: reviewError } = await db
      .from("vendor_reviews")
      .select("vendor_user_id, stars")
      .in("vendor_user_id", vendorUserIds);
    if (reviewError) throw new Error(reviewError.message);
    const starsByVendor = new Map<string, number[]>();
    for (const r of (reviewRows ?? []) as { vendor_user_id: string; stars: number }[]) {
      const list = starsByVendor.get(r.vendor_user_id) ?? [];
      list.push(r.stars);
      starsByVendor.set(r.vendor_user_id, list);
    }
    rows = rows.map((row) => {
      const stars = row.directoryVendorUserId ? (starsByVendor.get(row.directoryVendorUserId) ?? []) : [];
      const agg = computeVendorReviewAggregate(stars);
      return { ...row, rating: agg.average, reviewCount: agg.count };
    });
  }

  const minRating = filter?.minRating;
  if (typeof minRating === "number" && Number.isFinite(minRating) && minRating > 0) {
    rows = rows.filter((row) => (row.rating ?? 0) >= minRating);
  }

  return rows;
}
