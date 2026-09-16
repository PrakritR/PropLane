import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorNotificationSettings, saveVendorNotificationSettings } from "@/lib/vendor-notification-settings.server";

export const runtime = "nodejs";

/**
 * The vendor's own Settings → Notifications (PLAN-0915). Read by
 * `resolveChannels` for every vendor-facing send, so what is saved here is
 * what actually gates email and text — unlike the three legacy toggles it
 * replaces, which nothing read.
 */
async function requireVendor() {
  const access = await resolveVendorPortalUserId();
  if (!access.ok) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }),
    };
  }
  return { ok: true as const, userId: access.userId, db: createSupabaseServiceRoleClient() };
}

export async function GET() {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const settings = await loadVendorNotificationSettings(auth.db, auth.userId);
    return NextResponse.json({ settings }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load notification settings." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const current = await loadVendorNotificationSettings(auth.db, auth.userId);
    const settings = await saveVendorNotificationSettings(auth.db, auth.userId, {
      ...current,
      ...body,
      topics: { ...current.topics, ...((body.topics as Record<string, unknown> | undefined) ?? {}) },
      quietHours: { ...current.quietHours, ...((body.quietHours as Record<string, unknown> | undefined) ?? {}) },
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save notification settings." }, { status: 500 });
  }
}
