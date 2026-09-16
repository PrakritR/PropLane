import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { assertAutomationSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import { loadAutomatedMessageSettings, saveAutomatedMessageSettings } from "@/lib/automated-messages-settings.server";
import { automatedMessageDefaults } from "@/lib/automated-messages-defaults.server";

export const runtime = "nodejs";

/** "Messages sent automatically" — per-event switch and template (PLAN-0915). */
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
  if (!(roleList.includes("manager") || legacy === "manager" || legacy === "admin")) return null;
  return { db, userId: user.id };
}

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const settings = await loadAutomatedMessageSettings(ctx.db, ctx.userId);
    return NextResponse.json({ settings, defaults: automatedMessageDefaults() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertAutomationSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json().catch(() => ({}))) as { settings?: unknown };
    const settings = await saveAutomatedMessageSettings(ctx.db, ctx.userId, body.settings ?? body);
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
