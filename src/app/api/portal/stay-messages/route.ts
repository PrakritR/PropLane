import { NextResponse } from "next/server";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { assertSettingsScopeOwned } from "@/lib/scope/settings-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** The check-in / check-out messages logged for ONE booking (`block:<id>`), for the booking's Messages rows. Never returns a body or a code. */
export async function GET(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    if (!(await userHoldsManagerRole(db, user.id))) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const stayKey = (new URL(req.url).searchParams.get("stayKey") ?? "").trim();
    const blockId = /^block:(.{1,200})$/.exec(stayKey)?.[1];
    if (!blockId) return NextResponse.json({ rows: [] });
    const { data: block } = await db.from("portal_schedule_records").select("property_id, row_data").eq("id", blockId).maybeSingle();
    const propertyId = String((block as { property_id?: unknown } | null)?.property_id ?? (block as { row_data?: { propertyId?: unknown } } | null)?.row_data?.propertyId ?? "").trim();
    if (!propertyId) return NextResponse.json({ rows: [] });
    const access = await assertSettingsScopeOwned(db, user.id, { propertyId }, { intent: "read", level: "read" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const { data, error } = await db
      .from("stay_message_sends")
      .select("id, kind, status, hold_reason, due_at, sent_at, channels")
      .eq("stay_key", stayKey)
      .order("due_at", { ascending: true });
    if (error) return NextResponse.json({ rows: [] });
    return NextResponse.json({ rows: data ?? [] });
  } catch {
    return NextResponse.json({ error: "Could not load messages." }, { status: 503 });
  }
}
