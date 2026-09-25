import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { mapVendorReviewRow, normalizeVendorReviewBody, VENDOR_REVIEW_SELECT } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/** The vendor replies to a review of their own work. The reply stays editable (re-POST to change it). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const access = await resolveVendorPortalUserId();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const body = (await req.json()) as { reply?: string };
    const reply = normalizeVendorReviewBody(body.reply);
    if (!reply) return NextResponse.json({ error: "Reply cannot be empty." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    // Never trust the id alone — scope the write to the signed-in vendor's own review.
    const { data, error } = await db
      .from("vendor_reviews")
      .update({ vendor_reply: reply, vendor_replied_at: new Date().toISOString() })
      .eq("id", id)
      .eq("vendor_user_id", access.userId)
      .select(VENDOR_REVIEW_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Review not found." }, { status: 404 });

    return NextResponse.json({ review: mapVendorReviewRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save reply.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
