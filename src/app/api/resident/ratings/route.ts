import { NextResponse } from "next/server";
import { listRatingsForResident } from "@/lib/resident-ratings/ratings.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const privateHeaders = { "Cache-Control": "private, no-store" };

/** The signed-in person's own ratings (and their responses). The subject is the session, never a query parameter. */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: privateHeaders });
    const ratings = await listRatingsForResident(createSupabaseServiceRoleClient(), user.id);
    return NextResponse.json({ ratings }, { headers: privateHeaders });
  } catch {
    return NextResponse.json({ error: "Could not load your ratings." }, { status: 500, headers: privateHeaders });
  }
}
