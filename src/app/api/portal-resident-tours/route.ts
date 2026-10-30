import { NextResponse } from "next/server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentTourViews, linkAllTourInquiriesForEmail } from "@/lib/tour-resident-link.server";

export const runtime = "nodejs";

/** Scoped tour list for the signed-in resident — linked inquiry ids only. */
export async function GET() {
  try {
    const { user, profile } = await getEffectiveSessionForPortal("resident");
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const access = await ensureMayAccessResidentPortal(db, user);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const email = verifiedSessionEmail(user, profile?.email);
    if (email.includes("@")) {
      await linkAllTourInquiriesForEmail(db, { userId: user.id, email });
    }
    const tours = await loadResidentTourViews(db, user.id, { email });
    return NextResponse.json({ tours });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load tours.";
    // A failed read is NOT an empty tour list. This used to answer 200 with
    // `{tours: [], degraded: true}` when `resident_tour_links` was missing from
    // the schema cache, and the panel cleared its error on that flag — so a
    // resident holding a CONFIRMED tour was told, confidently, that they had
    // none. Every failure now leaves as a failure; `degraded` survives only to
    // tell the client this is the recoverable "try again" shape.
    if (/resident_tour_links|schema cache/i.test(message)) {
      return NextResponse.json(
        { error: "We could not load your tours right now. Try again in a moment.", degraded: true },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
