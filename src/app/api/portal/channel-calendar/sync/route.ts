import { NextResponse } from "next/server";

import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";
import { toPublicConnection } from "@/lib/channel-calendar/connections.server";
import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
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

export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const browserOrigin = url.searchParams.get("origin")?.trim() || url.origin;
    const body = (await req.json()) as { connectionId?: string };
    const connectionId = body.connectionId?.trim() ?? "";
    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
    }

    const { data: row } = await ctx.db
      .from("external_calendar_connections")
      .select("property_id")
      .eq("id", connectionId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    if (!(await managerHasCalendarAccessForProperty(ctx.db, ctx.userId, String(row.property_id)))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const saved = await syncChannelCalendarConnection(ctx.db, connectionId);
    return NextResponse.json({ connection: toPublicConnection(saved, browserOrigin) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed.";
    // Airbnb refusing or not returning a calendar is an UPSTREAM problem (a
    // revoked/typo'd export link, or Airbnb being down) — not a PropLane fault.
    // Reporting it as 502 with the remote's own words tells the manager what to
    // fix; a bare 500 read as "PropLane is broken".
    if (/Airbnb calendar returned|not a valid calendar file|fetch failed|aborted/i.test(message)) {
      return NextResponse.json(
        {
          error: `Could not read that Airbnb calendar (${message}). Check the export link is still valid in Airbnb, then sync again.`,
          upstream: true,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
