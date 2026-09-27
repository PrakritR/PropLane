import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { computeVendorReviewAggregate } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * GET ?vendorUserIds=a,b,c — a `{ [vendorUserId]: { average, count } }` map for
 * the manager Vendors list row glyph fact ("★ 4.6 · 12"), one request instead
 * of one per row.
 */
export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const url = new URL(req.url);
    const vendorUserIds = (url.searchParams.get("vendorUserIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (vendorUserIds.length === 0) return NextResponse.json({ aggregates: {} });

    const { data, error } = await auth.db
      .from("vendor_reviews")
      .select("vendor_user_id, stars")
      .in("vendor_user_id", vendorUserIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const starsByVendor = new Map<string, number[]>();
    for (const row of data ?? []) {
      const vendorUserId = String(row.vendor_user_id ?? "");
      if (!vendorUserId) continue;
      const list = starsByVendor.get(vendorUserId) ?? [];
      list.push(Number(row.stars ?? 0));
      starsByVendor.set(vendorUserId, list);
    }

    const aggregates: Record<string, ReturnType<typeof computeVendorReviewAggregate>> = {};
    for (const vendorUserId of vendorUserIds) {
      aggregates[vendorUserId] = computeVendorReviewAggregate(starsByVendor.get(vendorUserId) ?? []);
    }

    return NextResponse.json({ aggregates });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load review aggregates.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
