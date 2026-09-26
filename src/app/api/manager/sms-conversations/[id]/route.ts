import { NextResponse } from "next/server";
import { getPortalAccessContext, hasAdminRole, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { decodeSmsProjectionCursor, fetchManagerSmsProjectionDetail, resolveManagerSmsProjectionSelection } from "@/lib/sms/sms-projection-inbox.server";
import { updateSmsProjectionViewState } from "@/lib/sms/sms-projection.server";

export const runtime = "nodejs";

export async function GET(req: Request, context: RouteContext<"/api/manager/sms-conversations/[id]">) {
  const access = await getPortalAccessContext();
  if (!access.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(access, "manager") && !hasAdminRole(access)) {
    return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  }
  const { id } = await context.params;
  try {
    const db = createSupabaseServiceRoleClient();
    const selectedId = await resolveManagerSmsProjectionSelection(db, access.user.id, id);
    if (selectedId === "ambiguous") return NextResponse.json({ error: "This older conversation link is ambiguous. Open it from the list." }, { status: 409 });
    if (!selectedId) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    const before = decodeSmsProjectionCursor(new URL(req.url).searchParams.get("before"));
    const payload = await fetchManagerSmsProjectionDetail(db, access.user.id, selectedId, before);
    if (!payload) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load conversation.";
    return NextResponse.json({ error: message }, { status: message === "Invalid conversation cursor." ? 400 : 500 });
  }
}

export async function PATCH(req: Request, context: RouteContext<"/api/manager/sms-conversations/[id]">) {
  const access = await getPortalAccessContext();
  if (!access.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!hasRole(access, "manager") && !hasAdminRole(access)) {
    return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const body = await req.json().catch(() => null) as { action?: unknown; expectedVersion?: unknown; observed?: { occurredAt?: unknown; id?: unknown } } | null;
  if (!body || !["markRead", "archive", "restore"].includes(String(body.action)) ||
      typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
    return NextResponse.json({ error: "Invalid conversation action." }, { status: 400 });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    const detail = await fetchManagerSmsProjectionDetail(db, access.user.id, id, null);
    if (!detail) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    if (detail.stateVersion !== body.expectedVersion) {
      return NextResponse.json({ error: "Conversation changed. Reload and retry." }, { status: 409 });
    }
    const canonicalId = detail.resident.projectionId;
    const { data: row, error } = await db.from("sms_projection_conversations")
      .select("owner_manager_user_id").eq("id", canonicalId).single();
    if (error || !row) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    const action = body.action as "markRead" | "archive" | "restore";
    let readThrough: { occurredAt: string; id: string } | null = null;
    if (action === "markRead") {
      const occurredAt = String(body.observed?.occurredAt ?? "");
      const eventId = String(body.observed?.id ?? "");
      if (!Number.isFinite(Date.parse(occurredAt)) || !/^[0-9a-f-]{36}$/i.test(eventId)) {
        return NextResponse.json({ error: "Observed message required." }, { status: 400 });
      }
      const { data: member, error: memberError } = await db.rpc("sms_projection_observed_event", {
        p_owner: String(row.owner_manager_user_id), p_conversation: canonicalId, p_at: occurredAt, p_event: eventId,
      });
      if (memberError || member !== true) return NextResponse.json({ error: "Observed message is no longer available." }, { status: 409 });
      readThrough = { occurredAt, id: eventId };
    }
    const version = await updateSmsProjectionViewState(db, {
      ownerManagerUserId: String(row.owner_manager_user_id),
      viewerUserId: access.user.id,
      conversationId: canonicalId,
      expectedVersion: Number(body.expectedVersion),
      isArchived: action === "archive" ? true : action === "restore" ? false : detail.archived,
      readThrough,
    });
    if (version === null) return NextResponse.json({ error: "Conversation changed. Reload and retry." }, { status: 409 });
    return NextResponse.json({ ok: true, version }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update conversation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
