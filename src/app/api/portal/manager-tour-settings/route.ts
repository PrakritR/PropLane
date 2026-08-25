import { NextResponse } from "next/server";
import { loadManagerTourSettings, saveManagerTourSettings } from "@/lib/manager-tour-settings";
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
  const isManager =
    roleList.includes("manager") ||
    roleList.includes("owner") ||
    roleList.includes("pro") ||
    legacy === "manager" ||
    legacy === "admin" ||
    legacy === "owner" ||
    legacy === "pro";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function GET() {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const settings = await loadManagerTourSettings(ctx.db, ctx.userId);
    return NextResponse.json({ settings });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { tourNoticeDays?: unknown } | null;
    const settings = await saveManagerTourSettings(ctx.db, ctx.userId, body ?? {});
    return NextResponse.json({ settings });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
