import { NextResponse } from "next/server";

import { signedInWithGoogle } from "@/lib/google-calendar/link-from-auth.server";
import { googleCalendarOAuthRedirectUri } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import {
  clearGoogleCalendarConnection,
  DEFAULT_GOOGLE_CALENDAR_CONNECTION,
  googleCalendarPublicStatus,
  isGoogleCalendarOAuthConfigured,
  isGoogleCalendarSchemaReady,
  loadGoogleCalendarConnection,
  saveGoogleCalendarConnection,
  warmGoogleCalendarOAuthConfig,
} from "@/lib/google-calendar/settings";
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
  return { db, userId: user.id, user };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const browserOrigin = url.searchParams.get("origin")?.trim() || url.origin;
    await warmGoogleCalendarOAuthConfig();
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const schemaReady = await isGoogleCalendarSchemaReady(ctx.db);
    const connection = schemaReady
      ? await loadGoogleCalendarConnection(ctx.db, ctx.userId)
      : DEFAULT_GOOGLE_CALENDAR_CONNECTION;
    const googleAuthUser = signedInWithGoogle(ctx.user);
    const status = googleCalendarPublicStatus(connection, { googleAuthUser, schemaReady });
    debugGoogleCalendarLog("google-calendar/route.ts:GET", "calendar status", {
      managerSuffix: ctx.userId.slice(-6),
      connected: status.connected,
      configured: status.configured,
      schemaReady: status.schemaReady,
      googleAuthUser: status.googleAuthUser,
      missingSecret: !isGoogleCalendarOAuthConfigured() && Boolean(status.googleAuthUser),
    });
    return NextResponse.json({
      ...status,
      missingSecret: !status.configured && Boolean(status.googleAuthUser),
      oauthRedirectUri: googleCalendarOAuthRedirectUri(browserOrigin),
      managerEmail: ctx.user.email?.trim() || null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json()) as { syncEnabled?: boolean };
    const connection = await saveGoogleCalendarConnection(ctx.db, ctx.userId, {
      syncEnabled: body.syncEnabled !== false,
    });
    return NextResponse.json(googleCalendarPublicStatus(connection));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await clearGoogleCalendarConnection(ctx.db, ctx.userId);
    return NextResponse.json(googleCalendarPublicStatus(DEFAULT_GOOGLE_CALENDAR_CONNECTION));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return NextResponse.json({ configured: isGoogleCalendarOAuthConfigured() });
}
