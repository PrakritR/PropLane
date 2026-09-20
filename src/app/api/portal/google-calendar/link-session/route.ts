import { NextResponse } from "next/server";

import { maybeLinkGoogleCalendarFromOAuthSession, signedInWithGoogle } from "@/lib/google-calendar/link-from-auth.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { googleCalendarPublicStatus, loadGoogleCalendarConnection } from "@/lib/google-calendar/settings";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertGoogleCalendarProviderAllowed } from "@/lib/google-calendar/api.server";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id, supabaseAuth, user };
}

/** Try linking this manager's Google Calendar from the live auth session (post sign-in fallback). */
export async function POST() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "session_link");

    const {
      data: { session },
    } = await ctx.supabaseAuth.auth.getSession();

    debugGoogleCalendarLog("link-session/route.ts:POST", "link-session attempt", {
      managerSuffix: ctx.userId.slice(-6),
      hasSession: Boolean(session),
      hasRefresh: Boolean(session?.provider_refresh_token),
      hasAccess: Boolean(session?.provider_token),
      googleAuthUser: signedInWithGoogle(session?.user ?? ctx.user),
    });

    if (!session) {
      const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
      return NextResponse.json(
        googleCalendarPublicStatus(connection, { googleAuthUser: signedInWithGoogle(ctx.user) }),
      );
    }

    await maybeLinkGoogleCalendarFromOAuthSession(ctx.db, session.user, session, {
      nextPath: "/portal/calendar",
    });

    const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
    return NextResponse.json(
      googleCalendarPublicStatus(connection, { googleAuthUser: signedInWithGoogle(session.user) }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
