import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { mapPublicVendorReviewRow, normalizeVendorReviewBody, VENDOR_REVIEW_PUBLIC_SELECT } from "@/lib/vendor-reviews";

export const runtime = "nodejs";

/**
 * The vendor replies to a review of their own work. POST is the FIRST reply:
 * a review already carrying a `vendor_reply` is refused with 409 rather than
 * silently overwritten. Changing a reply already sent is a deliberate second
 * verb — PATCH below — so an accidental double-submit of the first reply can
 * never clobber a reply the vendor has since edited (vendor-portal-redesign-1006
 * brought back "Edit reply" in the row ⋯).
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
    if (readError) {
      console.error("[vendor/reviews/reply] read failed", readError.message);
      return NextResponse.json({ error: "Could not load the review." }, { status: 500 });
    }
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
    if (error) {
      console.error("[vendor/reviews/reply] save failed", error.message);
      return NextResponse.json({ error: "Could not save your reply." }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "Review not found." }, { status: 404 });

    return NextResponse.json({ review: mapPublicVendorReviewRow(data) });
  } catch (e) {
    console.error("[vendor/reviews/reply] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not save your reply." }, { status: 500 });
  }
}

/**
 * Edit a reply already sent (Reviews ⋯ → Edit reply). Scoped to the signed-in
 * vendor's own review and refused with 404 when there is no reply yet — the
 * first reply goes through POST. Only `vendor_reply` and its timestamp change.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const access = await resolveVendorPortalUserId();
    if (!access.ok) {
      return NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status });
    }

    const body = (await req.json().catch(() => ({}))) as { reply?: string };
    const reply = normalizeVendorReviewBody(body.reply);
    if (!reply) return NextResponse.json({ error: "Reply cannot be empty." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("vendor_reviews")
      .update({ vendor_reply: reply, vendor_replied_at: new Date().toISOString() })
      .eq("id", id)
      .eq("vendor_user_id", access.userId)
      .not("vendor_reply", "is", null)
      .select(VENDOR_REVIEW_PUBLIC_SELECT)
      .maybeSingle();
    if (error) {
      console.error("[vendor/reviews/reply] edit failed", error.message);
      return NextResponse.json({ error: "Could not save your reply." }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: "No reply to edit on this review." }, { status: 404 });

    return NextResponse.json({ review: mapPublicVendorReviewRow(data) });
  } catch (e) {
    console.error("[vendor/reviews/reply] failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not save your reply." }, { status: 500 });
  }
}
