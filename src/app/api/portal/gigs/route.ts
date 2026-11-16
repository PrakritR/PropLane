import { NextResponse } from "next/server";
import { fanOutGigOffers } from "@/lib/jobs/gig-offers.server";
import { GIG_KIND_LABEL, type GigKind } from "@/lib/jobs/gig-parse";
import { createGigPost } from "@/lib/jobs/gig-posts.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const KINDS = Object.keys(GIG_KIND_LABEL) as GigKind[];

/**
 * PropLane Jobs, the portal door (same records and notices as the text door, `post_gig`): a manager posts a priced job from
 * Services. The manager is the session user; the home is re-derived from their own property records by id; the price is
 * whole cents the person typed (never a model's). Offers to vendors go out after the job is saved, and a failed text never
 * undoes it.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind !== "normal") {
      return NextResponse.json({ error: "Posting jobs is unavailable for this account." }, { status: 403 });
    }
    const body = (await req.json().catch(() => ({}))) as { propertyId?: unknown; roomLabel?: unknown; kind?: unknown; offeredCents?: unknown; whenText?: unknown; workspaceId?: unknown };
    const kind = KINDS.find((k) => k === body.kind);
    const offeredCents = typeof body.offeredCents === "number" ? Math.round(body.offeredCents) : NaN;
    if (!kind) return NextResponse.json({ error: "Pick a kind of job." }, { status: 400 });
    if (!Number.isFinite(offeredCents)) return NextResponse.json({ error: "Enter a price." }, { status: 400 });
    // A workspace id in the body is a name, never a grant: it rides on the gig (and picks the notice's work number) only
    // when this manager owns that workspace.
    const askedWorkspace = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : null;
    let workspaceId: string | null = null;
    if (askedWorkspace) {
      const { data: owned } = await db.from("portal_workspaces").select("id").eq("id", askedWorkspace).eq("owner_user_id", user.id).maybeSingle();
      workspaceId = owned ? askedWorkspace : null;
    }
    const posted = await createGigPost(db, {
      managerUserId: user.id,
      workspaceId,
      propertyId: typeof body.propertyId === "string" ? body.propertyId : "",
      roomLabel: typeof body.roomLabel === "string" ? body.roomLabel.trim().slice(0, 40) || null : null,
      kind,
      offeredCents,
      whenText: typeof body.whenText === "string" ? body.whenText.trim().slice(0, 80) || null : null,
      source: "portal",
    });
    if (!posted.ok) return NextResponse.json({ error: posted.error }, { status: posted.status });
    const fan = posted.created ? await fanOutGigOffers(db, posted.gigId).catch(() => null) : null;
    return NextResponse.json({ ok: true, workOrderId: posted.workOrderId, code: posted.code, texted: fan?.sent ?? 0 });
  } catch {
    return NextResponse.json({ error: "Could not post the job." }, { status: 500 });
  }
}
