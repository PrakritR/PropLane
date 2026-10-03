import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { canEditVendorReview, normalizeVendorReviewStars, normalizeVendorReviewBody } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/** Manager may edit their own review for fourteen days (`canEditVendorReview`). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (auth.role !== "manager" && auth.role !== "admin") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const { data: existing, error: readError } = await auth.db
      .from("vendor_reviews")
      .select("id, reviewer_user_id, created_at")
      .eq("id", id)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Review not found." }, { status: 404 });

    if (existing.reviewer_user_id !== auth.userId) {
      return NextResponse.json({ error: "Only the reviewer may edit this review." }, { status: 403 });
    }
    if (!canEditVendorReview(String(existing.created_at))) {
      return NextResponse.json({ error: "Reviews can be edited for fourteen days." }, { status: 403 });
    }

    const body = await req.json() as { stars?: unknown; body?: unknown };
    const stars = normalizeVendorReviewStars(body.stars);
    if (stars === null) return NextResponse.json({ error: "Choose one to five stars." }, { status: 400 });
    const { error } = await auth.db.from("vendor_reviews").update({ stars, body: normalizeVendorReviewBody(body.body), updated_at: new Date().toISOString() })
      .eq("id", id).eq("reviewer_user_id", auth.userId).gt("created_at", new Date(Date.now() - 14 * 86400000).toISOString());
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update review.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
