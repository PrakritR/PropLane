import { NextResponse } from "next/server";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { cancelResidentTour } from "@/lib/tour-resident-cancel.server";

export const runtime = "nodejs";

/** The signed-in resident withdraws one of their own tours (pending or confirmed). */
export async function POST(req: Request) {
  try {
    const { user, profile } = await getEffectiveSessionForPortal("resident");
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const access = await ensureMayAccessResidentPortal(db, user);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const body = (await req.json().catch(() => ({}))) as { inquiryId?: unknown; reason?: unknown };
    const inquiryId = typeof body.inquiryId === "string" ? body.inquiryId.trim() : "";
    if (!inquiryId) return NextResponse.json({ error: "inquiryId required" }, { status: 400 });

    const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
    const result = await cancelResidentTour(db, {
      userId: user.id,
      email: email || null,
      inquiryId,
      reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to cancel tour.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
