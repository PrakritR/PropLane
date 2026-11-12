import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { saveResidentResponse } from "@/lib/resident-ratings/ratings.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

/** The person's one public response to a rating of theirs (an empty response clears it). Ownership is the session. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: privateHeaders });
    if (!(await rateLimit(`resident-rating-response:${user.id}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: privateHeaders });
    }
    const body = await req.json().catch(() => null);
    const result = await saveResidentResponse(createSupabaseServiceRoleClient(), user.id, id ?? "", body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: privateHeaders });
    return NextResponse.json({ rating: result.rating }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not save your response." }, { status: 500, headers: privateHeaders });
  }
}
