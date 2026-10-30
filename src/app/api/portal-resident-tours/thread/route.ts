import { NextResponse } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentTourViews } from "@/lib/tour-resident-link.server";
import { findResidentPropertyManagerThreadId } from "@/lib/property-manager-inbox-thread.server";

export const runtime = "nodejs";

/**
 * "Message the host": the resident's existing conversation with the host team of one of THEIR tours. The tour is re-derived
 * from the signed-in resident's own linked tours (`loadResidentTourViews`); `inquiryId` only names which one, and the manager
 * and house come from that tour, never from the request. No conversation yet answers `{ threadId: null }` and the client opens
 * the Communication list.
 */
export async function GET(request: Request) {
  try {
    const { user, profile } = await getEffectiveSessionForPortal("resident");
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const access = await ensureMayAccessResidentPortal(db, user);
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

    const inquiryId = new URL(request.url).searchParams.get("inquiryId")?.trim() ?? "";
    if (!inquiryId) return NextResponse.json({ error: "Choose a tour." }, { status: 400 });

    const email = verifiedSessionEmail(user, profile?.email);
    const tours = await loadResidentTourViews(db, user.id, { email });
    const tour = tours.find((t) => t.inquiryId === inquiryId);
    if (!tour) return NextResponse.json({ error: "Tour not found." }, { status: 404 });
    const managerUserId = tour.managerUserId?.trim() ?? "";
    const propertyId = tour.propertyId?.trim() ?? "";
    if (!managerUserId || !propertyId) return NextResponse.json({ threadId: null });

    const { data: manager } = await db.from("profiles").select("email").eq("id", managerUserId).maybeSingle();
    const threadId = await findResidentPropertyManagerThreadId(db, {
      residentUserId: user.id,
      residentEmail: email,
      managerUserId,
      managerEmail: String((manager as { email?: unknown } | null)?.email ?? ""),
      propertyId,
    });
    return NextResponse.json({ threadId });
  } catch {
    return NextResponse.json({ error: "We could not open that conversation." }, { status: 500 });
  }
}
