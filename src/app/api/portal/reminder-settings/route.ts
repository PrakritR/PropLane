/**
 * Per-manager reminder rules for the reminder spine.
 *
 * Mirrors `/api/portal/automation-settings`: manager-only, service-role write
 * pinned to the authenticated user's id, and the whole payload re-normalized
 * server-side so a hand-crafted request cannot store a lead time outside the
 * clamped range or a subject kind the dispatcher does not know.
 */
import { NextResponse } from "next/server";
import { loadReminderSettings, saveReminderSettings } from "@/lib/reminders/settings.server";
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

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const settings = await loadReminderSettings(ctx.db, ctx.userId);
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { settings?: unknown };
    // Merge onto what is stored so a partial patch cannot blank sibling rules.
    const current = await loadReminderSettings(ctx.db, ctx.userId);
    const incoming =
      body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
        ? (body.settings as Record<string, unknown>)
        : {};
    const settings = await saveReminderSettings(ctx.db, ctx.userId, {
      ...current,
      ...incoming,
      rules: { ...current.rules, ...((incoming.rules as Record<string, unknown>) ?? {}) },
    });
    return NextResponse.json({ settings });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
