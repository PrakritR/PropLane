import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";
import { loadWorkspaces } from "@/lib/workspaces/server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

export const runtime = "nodejs";

async function actor() {
  const session = await createSupabaseServerClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return null;
  return { user, db: createSupabaseServiceRoleClient() };
}

export async function GET() {
  try {
    const ctx = await actor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const workspaces = await loadWorkspaces(ctx.db, ctx.user.id);
    const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
    return NextResponse.json({
      workspaces,
      activeWorkspaceId: workspaces.find((w) => w.id === selected)?.id ?? workspaces[0]?.id ?? null,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load workspaces. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await actor();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = await request.json();
    const { user, db } = ctx;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const action = body.action;
    if (action === "select") {
      const workspaces = await loadWorkspaces(db, user.id);
      if (!workspaces.some((w) => w.id === body.id)) return NextResponse.json({ error: "Workspace access is unavailable." }, { status: 403 });
      const response = NextResponse.json({ ok: true, activeWorkspaceId: body.id });
      response.cookies.set(WORKSPACE_COOKIE, body.id, {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
    if (!await userIsPropertyPortalManager(db, user.id)) {
      return NextResponse.json({ error: "A manager account is required." }, { status: 403 });
    }
    if (action === "initialize") {
      const result = await db.rpc("ensure_default_portal_workspace", { p_owner: user.id });
      if (result.error) throw result.error;
      return NextResponse.json({ id: result.data });
    }
    if (action !== "create" && action !== "rename" && action !== "delete" && action !== "move-property") {
      return NextResponse.json({ error: "Unknown workspace action." }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if ((action === "create" || action === "rename") && (!name || name.length > 80)) {
      return NextResponse.json({ error: "Use a workspace name of 1–80 characters." }, { status: 400 });
    }
    if (action === "create") {
      // Reserve the default workspace first, even for a manager with no houses.
      const initial = await db.rpc("ensure_default_portal_workspace", { p_owner: user.id });
      if (initial.error) throw initial.error;
      const result = await db.from("portal_workspaces").insert({ owner_user_id: user.id, name }).select("id").single();
      if (result.error) throw result.error;
      return NextResponse.json({ id: result.data.id }, { status: 201 });
    }
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) {
      return NextResponse.json({ error: "A valid workspace is required." }, { status: 400 });
    }
    const existing = await db.from("portal_workspaces").select("id,is_default").eq("id", body.id).eq("owner_user_id", user.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return NextResponse.json({ error: "Only the workspace owner can change it." }, { status: 403 });
    if (action === "move-property") {
      if (typeof body.propertyId !== "string" || !body.propertyId.trim()) return NextResponse.json({ error: "Select a property." }, { status: 400 });
      // Both property ownership and destination ownership are server-derived.
      const result = await db.from("manager_property_records").update({ workspace_id: body.id })
        .eq("id", body.propertyId).eq("manager_user_id", user.id).select("id");
      if (result.error) throw result.error;
      if (!result.data?.length) return NextResponse.json({ error: "Property not found in your portfolio." }, { status: 404 });
    } else if (action === "delete") {
      if (existing.data.is_default) return NextResponse.json({ error: "The default workspace must be kept. You can rename it." }, { status: 409 });
      // FK RESTRICT atomically refuses a delete while properties remain or move in.
      const result = await db.from("portal_workspaces").delete().eq("id", body.id).eq("owner_user_id", user.id);
      if (result.error) throw result.error;
    } else {
      const result = await db.from("portal_workspaces").update({ name }).eq("id", body.id).eq("owner_user_id", user.id);
      if (result.error) throw result.error;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "23514") return NextResponse.json({ error: "Workspace limit reached: 3 owned workspaces and 10 property records per workspace, including drafts." }, { status: 409 });
    if (code === "23503") return NextResponse.json({ error: "Move the properties out before deleting this workspace." }, { status: 409 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    return NextResponse.json({ error: "Could not update the workspace. Please retry." }, { status: 503 });
  }
}
