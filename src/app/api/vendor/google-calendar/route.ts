import { NextResponse } from "next/server";

import { assertGoogleCalendarProviderAllowed, googleCalendarOAuthRedirectUri, stopGoogleCalendarWatch } from "@/lib/google-calendar/api.server";
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
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Vendor clone of `/api/portal/google-calendar` (status/toggle/disconnect).
 * Same storage as the manager route — `loadGoogleCalendarConnection` /
 * `saveGoogleCalendarConnection` operate on a bare `userId` (the underlying
 * table's `manager_user_id` column has no FK to a manager-specific table,
 * the same reuse-by-userId pattern documented for vendor Stripe Connect in
 * docs/agents/vendor-portal.md Phase 3) — no new table or migration needed.
 */
async function requireVendor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return null;
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  return { db: createSupabaseServiceRoleClient(), userId: resolved.userId, user };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const browserOrigin = url.searchParams.get("origin")?.trim() || url.origin;
    await warmGoogleCalendarOAuthConfig();
    const ctx = await requireVendor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "settings_read");
    const schemaReady = await isGoogleCalendarSchemaReady(ctx.db);
    const connection = schemaReady
      ? await loadGoogleCalendarConnection(ctx.db, ctx.userId)
      : DEFAULT_GOOGLE_CALENDAR_CONNECTION;
    const status = googleCalendarPublicStatus(connection, { googleAuthUser: false, schemaReady });
    debugGoogleCalendarLog("vendor/google-calendar:GET", "calendar status", {
      vendorSuffix: ctx.userId.slice(-6),
      connected: status.connected,
      configured: status.configured,
    });
    return NextResponse.json({
      ...status,
      missingSecret: !status.configured,
      oauthRedirectUri: googleCalendarOAuthRedirectUri(browserOrigin),
      managerEmail: ctx.user?.email?.trim() || null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireVendor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "settings_write");
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
    const ctx = await requireVendor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "disconnect");
    const connection = await loadGoogleCalendarConnection(ctx.db, ctx.userId);
    if (connection.channelId && connection.channelResourceId) {
      await stopGoogleCalendarWatch(ctx.db, ctx.userId, connection.channelId, connection.channelResourceId).catch(
        () => undefined,
      );
    }
    await clearGoogleCalendarConnection(ctx.db, ctx.userId);
    return NextResponse.json(googleCalendarPublicStatus(DEFAULT_GOOGLE_CALENDAR_CONNECTION));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function OPTIONS() {
  return NextResponse.json({ configured: isGoogleCalendarOAuthConfigured() });
}
