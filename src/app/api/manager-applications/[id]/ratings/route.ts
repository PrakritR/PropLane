import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { loadManagerRatingsView, saveManagerRating } from "@/lib/resident-ratings/ratings.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

/**
 * What a manager sees about a person's ratings, on an application record: the average, the count and the reviews
 * (stars, text, month and year, the house's city, the resident's response) - never who rated, never the other
 * workspace. Open only on an application the person submitted to this workspace and on this workspace's own
 * residents (`loadManagerRatingsView` decides; the id is a path segment authorized against the record, never a
 * resident id).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: privateHeaders });

    const result = await loadManagerRatingsView(createSupabaseServiceRoleClient(), user.id, id ?? "");
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: privateHeaders });
    return NextResponse.json(result.view, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not load ratings." }, { status: 500, headers: privateHeaders });
  }
}

/**
 * Rate (or edit your rating of) the resident this record is about. The body is `{ stars, review }` and nothing
 * else is read from it: the resident, the rater and the workspace are derived from the record and the session.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: privateHeaders });
    if (!(await rateLimit(`resident-rating:${user.id}`, 30, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: privateHeaders });
    }

    const body = await req.json().catch(() => null);
    const result = await saveManagerRating(createSupabaseServiceRoleClient(), user.id, id ?? "", body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: privateHeaders });
    return NextResponse.json(result.view, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not save the rating." }, { status: 500, headers: privateHeaders });
  }
}
