import { NextResponse } from "next/server";

import { assertGoogleCalendarProviderAllowed } from "@/lib/google-calendar/api.server";
import { listPendingGoogleCalendarChanges, pullProplaneCalendarPendingChanges } from "@/lib/google-calendar/proplane-calendar-reconcile.server";
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
  return { db, userId: user.id };
}

/**
 * "Google edited or deleted a PropLane event" attention items — a manager's
 * confirmed tours and service visits that were changed on the manager's OWN
 * Google Calendar since PropLane last pushed them, surfaced here for an
 * explicit accept/dismiss rather than ever silently rescheduling anything.
 * See `proplane-calendar-reconcile.server.ts` for the full design.
 */
export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    await assertGoogleCalendarProviderAllowed(ctx.db, ctx.userId, "pending_changes_read");
    const url = new URL(req.url);
    // Cheap enough to run inline (one incremental-sync page, same discipline
    // as the events route's poll-on-read) rather than needing its own webhook
    // — this route is only ever hit when a manager has the Calendar page
    // open, so a fresh pull right before listing is the simplest way to keep
    // the list current without a second push-notification pipeline.
    if (url.searchParams.get("skipPull") !== "true") {
      await pullProplaneCalendarPendingChanges(ctx.db, ctx.userId, "manager").catch(() => undefined);
    }
    const pending = await listPendingGoogleCalendarChanges(ctx.db, ctx.userId);
    return NextResponse.json({ pending });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
