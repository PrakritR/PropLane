import { NextResponse } from "next/server";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { canEditVendorReview } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * C158: reviews can never be edited once posted, regardless of age or who is
 * asking. `canEditVendorReview` always returns false now — this route still
 * calls it (rather than inlining `false`) so there is exactly one place that
 * decision lives, the same contract the dialog reads client-side.
 */
export async function PATCH(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

    if (auth.role !== "admin" && existing.reviewer_user_id !== auth.userId) {
      return NextResponse.json({ error: "Only the reviewer may edit this review." }, { status: 403 });
    }
    if (!canEditVendorReview(String(existing.created_at))) {
      return NextResponse.json({ error: "Reviews cannot be edited once posted." }, { status: 403 });
    }

    // Unreachable while `canEditVendorReview` always refuses — kept so this
    // route still 403s explicitly rather than falling through silently if
    // that policy function is ever restored to a real window.
    return NextResponse.json({ error: "Reviews cannot be edited once posted." }, { status: 403 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update review.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
