import { NextResponse } from "next/server";

import { resolveRequestOrigin } from "@/lib/app-url";
import { loadChannelHealth } from "@/lib/channel-calendar/channel-health.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Integrations › Bookings › Channels: house x channel state, the vacancy each posting should advertise, and the
 * attention items (stale feed, missing echo, long closures). Read-only. Houses are authorized by
 * `listManagerChannelCalendarBookings` (workspace scope + calendar access per house), exactly like the bookings read.
 */
export async function GET(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const [{ data: profile }, { data: roles }] = await Promise.all([
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
      db.from("profile_roles").select("role").eq("user_id", user.id),
    ]);
    const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
    const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    if (!(roleList.includes("manager") || legacy === "manager" || legacy === "admin")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const refused = await refuseOwnerOnly(db, user.id);
    if (refused) return refused;
    const ids = (new URL(req.url).searchParams.get("propertyIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const health = await loadChannelHealth(db, user.id, ids, resolveRequestOrigin(req));
    return NextResponse.json(health, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
