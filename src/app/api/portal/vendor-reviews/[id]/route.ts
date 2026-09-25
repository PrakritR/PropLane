import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import {
  canEditVendorReview,
  mapVendorReviewRow,
  normalizeVendorReviewBody,
  normalizeVendorReviewStars,
  VENDOR_REVIEW_SELECT,
} from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/** The reviewer edits their own review, only within 14 days of creation. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json()) as { stars?: number; body?: string };
    const stars = normalizeVendorReviewStars(body.stars);
    if (stars == null) return NextResponse.json({ error: "Rating must be 1 to 5 stars." }, { status: 400 });
    const reviewBody = normalizeVendorReviewBody(body.body);

    const { data: existing, error: readError } = await auth.db
      .from("vendor_reviews")
      .select("id, reviewer_user_id, created_at")
      .eq("id", id)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Review not found." }, { status: 404 });

    if (auth.role !== "admin" && existing.reviewer_user_id !== auth.userId) {
      return NextResponse.json({ error: "Only the reviewer may edit this review." }, { status: 403 });
    }
    if (!canEditVendorReview(String(existing.created_at))) {
      return NextResponse.json({ error: "The 14-day edit window for this review has passed." }, { status: 409 });
    }

    const { data, error } = await auth.db
      .from("vendor_reviews")
      .update({ stars, body: reviewBody, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(VENDOR_REVIEW_SELECT)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ review: mapVendorReviewRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update review.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
