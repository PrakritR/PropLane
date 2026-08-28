import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentApplicationAutofillProfile } from "@/lib/rental-application/resident-application-autofill.server";

export const runtime = "nodejs";

/**
 * Returns reusable answers from the caller's most recent submitted application
 * (any manager). Property-specific fields — move-in dates, room choices, fee
 * acknowledgements — are never included.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    const profile = await loadResidentApplicationAutofillProfile(db, user.email);
    if (!profile) {
      return NextResponse.json({ profile: null });
    }
    return NextResponse.json({ profile });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load saved application info.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
