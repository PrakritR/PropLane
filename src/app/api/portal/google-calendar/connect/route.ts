import { NextResponse } from "next/server";

import { buildGoogleCalendarOAuthUrl, googleCalendarOAuthRedirectUri } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { isGoogleCalendarOAuthConfigured, warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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
  return { db, userId: user.id, userEmail: user.email?.trim() || null };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const originParam = url.searchParams.get("origin")?.trim();
  const origin = originParam || url.origin;
  const returnPath = sanitizeOAuthReturnPath(url.searchParams.get("returnTo"), "/portal/calendar");
  const returnTo = `${origin.replace(/\/$/, "")}${returnPath}`;

  try {
    await warmGoogleCalendarOAuthConfig();
    if (!isGoogleCalendarOAuthConfigured()) {
      debugGoogleCalendarLog("connect/route.ts:GET", "calendar oauth not configured", {
        hypothesisId: "H7",
        origin,
      });
      const reason = encodeURIComponent("Google Calendar OAuth is not configured on this server.");
      return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
    }
    const ctx = await requireManager();
    if (!ctx) {
      debugGoogleCalendarLog("connect/route.ts:GET", "calendar oauth unauthorized", {
        hypothesisId: "H6",
        origin,
      });
      const reason = encodeURIComponent("Sign in as a manager on this port, then try again.");
      return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
    }
    const redirectUri = googleCalendarOAuthRedirectUri(origin);
    debugGoogleCalendarLog("connect/route.ts:GET", "calendar oauth redirect", {
      hypothesisId: "H2",
      runId: "post-fix-v8",
      managerSuffix: ctx.userId.slice(-6),
      browserOrigin: origin,
      redirectUri,
    });
    const oauthUrl = buildGoogleCalendarOAuthUrl(origin, ctx.userId, returnPath, {
      loginHint: ctx.userEmail,
    });
    return NextResponse.redirect(oauthUrl);
  } catch (e) {
    debugGoogleCalendarLog("connect/route.ts:GET", "calendar oauth failed", {
      hypothesisId: "H8",
      message: e instanceof Error ? e.message : "unknown",
      origin,
    });
    const reason = encodeURIComponent(e instanceof Error ? e.message : "Failed to start Google Calendar connect.");
    return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
  }
}
