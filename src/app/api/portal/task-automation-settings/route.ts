/**
 * Per-manager lifecycle task rules.
 *
 * Mirrors the other portal settings routes: manager-only, service-role write
 * pinned to the authenticated user's id, and the payload re-normalized
 * server-side so a hand-crafted request cannot store an out-of-range deadline
 * or a task key the generator does not know.
 */
import { NextResponse } from "next/server";
import {
  loadLifecycleAutomation,
  saveLifecycleAutomation,
} from "@/lib/task-lifecycle-automation.server";
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
    const automation = await loadLifecycleAutomation(ctx.db, ctx.userId);
    return NextResponse.json({ automation });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { automation?: unknown };
    // Merge onto what is stored so a partial patch cannot blank sibling rules.
    const current = await loadLifecycleAutomation(ctx.db, ctx.userId);
    const incoming =
      body.automation && typeof body.automation === "object" && !Array.isArray(body.automation)
        ? (body.automation as Record<string, unknown>)
        : {};
    const automation = await saveLifecycleAutomation(ctx.db, ctx.userId, { ...current, ...incoming });
    return NextResponse.json({ automation });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
