import { NextResponse } from "next/server";
import {
  RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN,
  RESIDENT_SCHEDULED_MESSAGE_DELETE_FORBIDDEN,
  isResidentOriginatedScheduledRow,
  updateScheduledInboxMessage,
  updateScheduledInboxMessageForResident,
} from "@/lib/scheduled-inbox-messages.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type PortalRole = "manager" | "resident";

async function requirePortalActor(preferredRole?: PortalRole) {
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
  const isManager = roleList.includes("manager") || roleList.includes("admin") || legacy === "manager" || legacy === "admin";
  const isResident = roleList.includes("resident") || legacy === "resident";
  if (!isManager && !isResident) return null;

  let role: PortalRole;
  if (isManager && isResident) {
    role = preferredRole === "resident" ? "resident" : "manager";
  } else {
    role = isManager ? "manager" : "resident";
  }

  return { db, userId: user.id, role };
}

function parsePreferredRole(req: Request, body?: { senderPortal?: string }): PortalRole | undefined {
  const url = new URL(req.url);
  const queryRole = url.searchParams.get("as");
  if (queryRole === "resident" || queryRole === "manager") return queryRole;
  if (body?.senderPortal === "resident") return "resident";
  if (body?.senderPortal === "manager") return "manager";
  return undefined;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const body = (await req.json()) as {
      cancelled?: boolean;
      subject?: string;
      body?: string;
      sendAt?: string;
      deliverViaEmail?: boolean;
      deliverViaSms?: boolean;
      senderPortal?: string;
    };
    const preferredRole = parsePreferredRole(req, body);
    const auth = await requirePortalActor(preferredRole);
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id } = await ctx.params;

    if (auth.role === "resident") {
      if (body.cancelled === true) {
        await updateScheduledInboxMessageForResident(auth.db, auth.userId, id, {
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        });
        return NextResponse.json({ ok: true });
      }
      if (body.cancelled === false) {
        await updateScheduledInboxMessageForResident(auth.db, auth.userId, id, {
          status: "scheduled",
          cancelledAt: null,
        });
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ error: "Residents can only cancel scheduled messages." }, { status: 403 });
    }

    if (body.cancelled === true) {
      await updateScheduledInboxMessage(auth.db, auth.userId, id, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true });
    }
    if (body.cancelled === false) {
      await updateScheduledInboxMessage(auth.db, auth.userId, id, {
        status: "scheduled",
        cancelledAt: null,
      });
      return NextResponse.json({ ok: true });
    }

    const patch: Parameters<typeof updateScheduledInboxMessage>[3] = {};
    if (typeof body.subject === "string") patch.subject = body.subject.trim();
    if (typeof body.body === "string") patch.body = body.body.trim();
    if (typeof body.deliverViaEmail === "boolean") patch.deliverViaEmail = body.deliverViaEmail;
    if (typeof body.deliverViaSms === "boolean") patch.deliverViaSms = body.deliverViaSms;
    if (typeof body.sendAt === "string" && body.sendAt.trim()) {
      const sendAt = new Date(body.sendAt);
      if (Number.isNaN(sendAt.getTime())) {
        return NextResponse.json({ error: "Invalid send date." }, { status: 400 });
      }
      patch.sendAt = sendAt.toISOString();
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No changes provided." }, { status: 400 });
    }

    await updateScheduledInboxMessage(auth.db, auth.userId, id, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    const status = message === RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const preferredRole = parsePreferredRole(req);
    const auth = await requirePortalActor(preferredRole);
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { id } = await ctx.params;

    if (auth.role === "resident") {
      const { error } = await auth.db
        .from("portal_scheduled_inbox_message_records")
        .delete()
        .eq("id", id)
        .eq("row_data->>senderPortal", "resident")
        .eq("row_data->>senderUserId", auth.userId);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    const { data: existing } = await auth.db
      .from("portal_scheduled_inbox_message_records")
      .select("row_data")
      .eq("id", id)
      .eq("manager_user_id", auth.userId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "Scheduled message not found." }, { status: 404 });
    }
    const prev = (existing.row_data ?? {}) as Record<string, unknown>;
    if (isResidentOriginatedScheduledRow(prev)) {
      return NextResponse.json({ error: RESIDENT_SCHEDULED_MESSAGE_DELETE_FORBIDDEN }, { status: 403 });
    }

    const { error } = await auth.db
      .from("portal_scheduled_inbox_message_records")
      .delete()
      .eq("id", id)
      .eq("manager_user_id", auth.userId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    const status =
      message === RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN ||
      message === RESIDENT_SCHEDULED_MESSAGE_DELETE_FORBIDDEN
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
