import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { mapPublicVendorReviewRow, normalizeVendorReviewBody, VENDOR_REVIEW_PUBLIC_SELECT } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * The vendor replies to a review of their own work, once (C157). A review
 * already carrying a `vendor_reply` is refused with 409 rather than
 * overwritten — the UI's "Edit reply" affordance was removed to match; this
 * is the server-side lock so the removal isn't just a client-side fig leaf.
 */
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
    // Never trust the id alone — scope the read/write to the signed-in vendor's own review.
    const { data: existing, error: readError } = await db
      .from("vendor_reviews")
      .select("id, vendor_reply")
      .eq("id", id)
      .eq("vendor_user_id", access.userId)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: "Review not found." }, { status: 404 });
    if (existing.vendor_reply) {
      return NextResponse.json({ error: "A reply has already been sent for this review." }, { status: 409 });
    }

    const { data, error } = await db
      .from("vendor_reviews")
      .update({ vendor_reply: reply, vendor_replied_at: new Date().toISOString() })
      .eq("id", id)
      .eq("vendor_user_id", access.userId)
      .select(VENDOR_REVIEW_PUBLIC_SELECT)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Review not found." }, { status: 404 });

    return NextResponse.json({ review: mapPublicVendorReviewRow(data) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save reply.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
