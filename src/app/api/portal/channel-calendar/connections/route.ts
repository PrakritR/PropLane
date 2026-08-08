import { NextResponse } from "next/server";

import {
  deleteChannelCalendarConnection,
  listChannelCalendarConnections,
  upsertChannelCalendarConnection,
} from "@/lib/channel-calendar/sync.server";
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

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) {
      return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    }
    if (!(await managerHasCalendarAccessForProperty(ctx.db, ctx.userId, propertyId))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const browserOrigin = url.searchParams.get("origin")?.trim() || url.origin;
    const connections = await listChannelCalendarConnections(ctx.db, propertyId, browserOrigin);
    return NextResponse.json({ connections });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const browserOrigin = url.searchParams.get("origin")?.trim() || url.origin;
    const body = (await req.json()) as {
      propertyId?: string;
      roomId?: string;
      label?: string | null;
      importUrl?: string | null;
    };

    const propertyId = body.propertyId?.trim() ?? "";
    const roomId = body.roomId?.trim() ?? "";
    if (!propertyId || !roomId) {
      return NextResponse.json({ error: "propertyId and roomId are required." }, { status: 400 });
    }
    if (!(await managerHasCalendarAccessForProperty(ctx.db, ctx.userId, propertyId))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const connection = await upsertChannelCalendarConnection(
      ctx.db,
      {
        managerUserId: ctx.userId,
        propertyId,
        roomId,
        label: body.label ?? null,
        importUrl: body.importUrl ?? null,
      },
      browserOrigin,
    );
    return NextResponse.json({ connection });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const connectionId = url.searchParams.get("id")?.trim() ?? "";
    if (!connectionId) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
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

    await deleteChannelCalendarConnection(ctx.db, connectionId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    const status = message === "Connection not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
