import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { disputeResidentRating } from "@/lib/resident-ratings/ratings.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

/**
 * Dispute a rating of theirs: opens a PropLane support thread (shared admin inbox, no email or text is sent) and marks
 * the rating "Disputed by resident" for future managers until an admin resolves it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: privateHeaders });
    if (!(await rateLimit(`resident-rating-dispute:${user.id}`, 5, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: privateHeaders });
    }

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const body = await req.json().catch(() => null);
    const result = await disputeResidentRating(
      db,
      { userId: user.id, email: user.email, name: String(profile?.full_name ?? "").trim() || user.email },
      id ?? "",
      body,
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: privateHeaders });
    return NextResponse.json({ rating: result.rating, alreadyDisputed: result.alreadyDisputed }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not record the dispute." }, { status: 500, headers: privateHeaders });
  }
}
