import { NextResponse } from "next/server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";

export const runtime = "nodejs";

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Resolve another workspace by PropLane ID (`profiles.manager_id`) or by email.
 * Owner and manager workspaces validate separately per Account links tab.
 * Requires an authenticated caller and returns minimal fields (no email).
 */
export async function GET(req: Request) {
  try {
    if (!(await rateLimit(`lookup-axis-id:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }

    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const axisId = searchParams.get("axisId")?.trim() ?? "";
    const email = searchParams.get("email")?.trim().toLowerCase() ?? "";
    if (!axisId && !email) {
      return NextResponse.json({ error: "PropLane ID or email is required." }, { status: 400 });
    }
    if (email && !looksLikeEmail(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();
    const profileQuery = supabase.from("profiles").select("id, full_name, manager_id, role");
    const { data: profile, error } = email
      ? await profileQuery.ilike("email", email).limit(1).maybeSingle()
      : await profileQuery
          .in("manager_id", (() => {
            const lookupIds = proplaneIdLookupVariants(axisId);
            return lookupIds.length > 0 ? lookupIds : [axisId];
          })())
          .limit(1)
          .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!profile?.id) {
      return NextResponse.json(
        {
          ok: false,
          error: email ? "No manager account found with this email." : "No account found with this PropLane ID.",
        },
        { status: 404 },
      );
    }

    const eligible = await userIsPropertyPortalManager(supabase, profile.id);
    if (!eligible) {
      return NextResponse.json(
        { ok: false, error: "This account is not eligible for co-manager linking (must be a property portal manager)." },
        { status: 400 },
      );
    }

    const role = String(profile.role ?? "").toLowerCase();
    const resolvedAxisId = String(profile.manager_id ?? axisId);

    return NextResponse.json({
      ok: true,
      userId: profile.id,
      axisId: resolvedAxisId,
      displayName: profile.full_name?.trim() || resolvedAxisId || email,
      role: role === "owner" ? "owner" : "manager",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
