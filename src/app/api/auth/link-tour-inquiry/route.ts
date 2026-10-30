import { NextResponse } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { linkTourInquiryToResident } from "@/lib/tour-resident-link.server";

export const runtime = "nodejs";

/** Link a tour inquiry to the signed-in resident account (record + email gate). */
export async function POST(req: Request) {
  try {
    const { user, profile } = await getEffectiveSessionForPortal("resident");
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const access = await ensureMayAccessResidentPortal(db, user);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const email = verifiedSessionEmail(user, profile?.email);
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Profile email required." }, { status: 400 });
    }

    let body: { tourInquiryId?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const tourInquiryId = typeof body.tourInquiryId === "string" ? body.tourInquiryId.trim() : "";
    if (!tourInquiryId) {
      return NextResponse.json({ error: "tourInquiryId is required." }, { status: 400 });
    }

    const result = await linkTourInquiryToResident(db, {
      userId: user.id,
      inquiryId: tourInquiryId,
      email,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, inquiryId: result.inquiryId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to link tour.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
