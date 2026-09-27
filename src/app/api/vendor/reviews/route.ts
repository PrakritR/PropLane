import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { computeVendorReviewAggregate, mapPublicVendorReviewRow, VENDOR_REVIEW_PUBLIC_SELECT } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * The signed-in vendor's own reviews, most recent first. Explicit
 * column projection — never `manager_user_id` / `reviewer_user_id` /
 * `work_order_id` — a vendor learns THAT they were reviewed and by whom
 * they replied to, never which manager or workspace wrote it.
 */
export async function GET() {
  try {
    const access = await resolveVendorPortalUserId();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("vendor_reviews")
      .select(VENDOR_REVIEW_PUBLIC_SELECT)
      .eq("vendor_user_id", access.userId)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const reviews = (data ?? []).map(mapPublicVendorReviewRow);
    const aggregate = computeVendorReviewAggregate(reviews.map((r) => r.stars));
    return NextResponse.json({ reviews, aggregate });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load reviews.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
