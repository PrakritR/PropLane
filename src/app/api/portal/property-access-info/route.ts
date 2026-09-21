import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadPropertyAccessInfo, savePropertyAccessInfo } from "@/lib/property-access-info";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
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

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId required." }, { status: 400 });
    const accessInfo = await loadPropertyAccessInfo(ctx.db, ctx.userId, propertyId);
    return NextResponse.json({ accessInfo });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load access info.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { propertyId?: string; accessInfo?: unknown };
    const propertyId = body.propertyId?.trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId required." }, { status: 400 });

    // When the property has a listing record, it must belong to this manager;
    // legacy/demo property ids without a record are still allowed and stay
    // isolated per-manager by the composite key.
    const { data: propertyRecord } = await ctx.db
      .from("manager_property_records")
      .select("manager_user_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (propertyRecord && propertyRecord.manager_user_id !== ctx.userId) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const accessInfo = await savePropertyAccessInfo(ctx.db, ctx.userId, propertyId, body.accessInfo);
    return NextResponse.json({ accessInfo });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save access info.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
