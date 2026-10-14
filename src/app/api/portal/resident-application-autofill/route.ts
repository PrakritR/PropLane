import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { residentApplicationAutofillExists, loadResidentApplicationAutofillProfile } from "@/lib/rental-application/resident-application-autofill.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Returns reusable answers from the caller's most recent submitted application
 * (any manager). Property-specific fields — move-in dates, room choices, fee
 * acknowledgements — are never included.
 *
 * `?exists=1` answers `{ hasProfile }` alone. The public listing page only needs to know whether there is
 * a saved application to reuse, and the saved answers carry the SSN, the licence and the ID photos: that
 * payload has no business being fetched into a public bundle to compute a boolean.
 */
export async function GET(request: Request) {
  try {
    const existsOnly = new URL(request.url).searchParams.get("exists") === "1";
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Application access is unavailable for this account." }, { status: 403 });
    }
    if (existsOnly) {
      return NextResponse.json({ hasProfile: await residentApplicationAutofillExists(db, user.email) });
    }
    const profile = await loadResidentApplicationAutofillProfile(db, user.email);
    const metadata = user.user_metadata ?? {};
    const name = typeof metadata.full_name === "string"
      ? metadata.full_name
      : typeof metadata.name === "string"
        ? metadata.name
        : "";
    const phone = typeof user.phone === "string" ? user.phone : "";
    const identity = { fullLegalName: name.trim(), phone: phone.trim(), email: user.email.trim() };
    if (!profile) {
      return NextResponse.json({ profile: null, identity });
    }
    return NextResponse.json({ profile, identity });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not load saved application info.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
