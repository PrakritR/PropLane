import { storedSmsNoticeIdentity } from "@/lib/sms-inbox-state.server";
import { smsNoticePhone } from "@/lib/sms-inbox-identity";
import { NextResponse } from "next/server";
import { getPortalAccessContext, hasRole, hasAdminRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";
import { canReplaceConversationHouses, loadAssignableConversationHouses } from "@/lib/sms/conversation-house-access.server";
import { loadConversationHouseScope } from "@/lib/sms/conversation-houses.server";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { TOUR_INTEREST_DELAY_MS, followupDelivery } from "@/lib/reminders/tour-interest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
async function context(key: string, inboxThreadId?: string) {
  const access = await getPortalAccessContext();
  if (!access.user || (!hasRole(access, "manager") && !hasAdminRole(access))) return null;
  const db = createSupabaseServiceRoleClient();
  const inbox = await fetchManagerSmsConversations(db, access.user.id);
  if (inboxThreadId) {
    const { data: notice, error } = await db.from("portal_inbox_thread_records")
      .select("id, owner_user_id, scope, thread_type, row_data").eq("id", inboxThreadId).maybeSingle();
    if (error) throw error;
    if (!notice || !storedSmsNoticeIdentity(notice)) return null;
    const scope = await linkedOwnerScopeForModule(db, access.user.id, "inbox", "edit", { throwOnError: true });
    if (notice.owner_user_id !== access.user.id && !scope.ownerIds.has(notice.owner_user_id)) return null;
    const phone = smsNoticePhone(notice.row_data?.smsNoticePhone || notice.row_data?.from);
    const matches = inbox.residents.filter(item => item.ownerManagerUserId === notice.owner_user_id && smsNoticePhone(item.phone) === phone);
    const keys = [...new Set(matches.flatMap(item => [item.conversationKey!, ...(item.memberKeys ?? [])]).filter(Boolean))];
    return { db, actor: access.user.id, owner: notice.owner_user_id as string, keys };
  }
  const thread = inbox.residents.find((item) => item.conversationKey === key || item.memberKeys?.includes(key));
  if (!thread?.ownerManagerUserId) return null;
  const keys = [...new Set([thread.conversationKey!, ...(thread.memberKeys ?? [])])];
  return { db, actor: access.user.id, owner: thread.ownerManagerUserId, keys };
}

export async function GET(req: Request) {
  try {
    const auth = await getPortalAccessContext();
    if (!auth.user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers });
    if (!hasRole(auth, "manager") && !hasAdminRole(auth)) return NextResponse.json({ error: "Manager access required." }, { status: 403, headers });
    const keys = [...new Set(new URL(req.url).searchParams.getAll("conversationKey").map(key => key.trim()).filter(Boolean))];
    if (keys.length === 0 || keys.length > 20) return NextResponse.json({ error: "Choose a conversation." }, { status: 400, headers });
    const db = createSupabaseServiceRoleClient();
    const readScope = await linkedOwnerScopeForModule(db, auth.user.id, "inbox", "read", { throwOnError: true });
    const { data, error } = await db.from("portal_reminder_records")
      .select("id, manager_user_id, status, send_at, payload")
      .in("manager_user_id", [auth.user.id, ...readScope.ownerIds]).eq("kind", "tour_interest")
      .in("payload->>conversationKey", keys).order("send_at", { ascending: false }).limit(10);
    if (error) throw error;
    const visible = (data ?? []).filter((row) => row.manager_user_id === auth.user!.id ||
      readScope.propertyIdsByOwner.get(row.manager_user_id)?.has(row.payload?.propertyId));
    if (visible.length === 0) return NextResponse.json({ reminders: [] }, { headers });
    const { assignable } = await loadAssignableConversationHouses(db, auth.user.id);
    const { data: outboxes, error: outboxError } = await db.from("sms_outbox")
      .select("manager_user_id,dedupe_key,status,dispatch_started_at,provider_message_sid,blocked_reason")
      .in("manager_user_id", [...new Set(visible.map(row => row.manager_user_id))])
      .in("dedupe_key", visible.map(row => `tour-interest:${row.id}`));
    if (outboxError) throw outboxError;
    return NextResponse.json({ reminders: visible.map((row) => {
      const delivery = followupDelivery(row, outboxes?.find(item => item.manager_user_id === row.manager_user_id && item.dedupe_key === `tour-interest:${row.id}`));
      const canChange = assignable.get(row.payload?.propertyId)?.ownerUserId === row.manager_user_id;
      return { id: row.id, conversationKey: row.payload?.conversationKey, status: delivery.status, sendAt: row.send_at, body: row.payload?.customBody,
        canEdit: delivery.canEdit && canChange, canCancel: delivery.canCancel && canChange };
    }) }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not load follow-ups." }, { status: 503, headers });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || (typeof body.conversationKey !== "string" && !(typeof body.inboxThreadId === "string" && ["archive", "restore"].includes(body.action))) || !["cancel", "edit", "archive", "restore"].includes(body.action) ||
      (["cancel", "edit"].includes(body.action) && (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)))) {
      return NextResponse.json({ error: "Choose a conversation and action." }, { status: 400, headers });
    }
    const ctx = await context(body.conversationKey, body.inboxThreadId);
    if (!ctx) return NextResponse.json({ error: "Conversation not found." }, { status: 404, headers });
    if (ctx.keys.length === 0) return NextResponse.json({ ok: true }, { headers });
    const revision = await ctx.db.rpc("conversation_house_access_revision", { p_actor: ctx.actor });
    if (revision.error || typeof revision.data !== "string") throw new Error("Access unavailable");
    const access = await loadAssignableConversationHouses(ctx.db, ctx.actor);
    let expectedTags: Awaited<ReturnType<typeof loadConversationHouseScope>> = [];
    if (["archive", "restore"].includes(body.action)) {
      const tags = await loadConversationHouseScope(ctx.db, ctx.owner, ctx.keys);
      expectedTags = tags;
      const ids = tags.map(tag => tag.property_id);
      if (!canReplaceConversationHouses({ viewerId: ctx.actor, ownerId: ctx.owner, currentIds: ids, nextIds: ids, ...access })) {
        return NextResponse.json({ error: "You do not have permission to change this conversation." }, { status: 403, headers });
      }
    }
    let sendAt: string | null = null;
    if (body.action === "edit") {
      const { data: row, error } = await ctx.db.from("portal_reminder_records").select("payload,send_at")
        .eq("id", body.id).eq("manager_user_id", ctx.owner).eq("kind", "tour_interest")
        .in("payload->>conversationKey", ctx.keys).maybeSingle();
      if (error) throw error;
      if (!row) return NextResponse.json({ error: "Follow-up not found." }, { status: 404, headers });
      const desired = body.sendAt ? Date.parse(body.sendAt) : Date.parse(row.send_at);
      const anchor = Date.parse(row.payload?.anchorIso ?? "");
      if (typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > 1600 ||
        !Number.isFinite(desired) || !Number.isFinite(anchor) || desired < Math.max(Date.now(), anchor + TOUR_INTEREST_DELAY_MS)) {
        return NextResponse.json({ error: "Enter a message and a future time at least 24 hours after the tour response." }, { status: 400, headers });
      }
      sendAt = new Date(desired).toISOString();
    }
    const result = await ctx.db.rpc("change_tour_interest_followup", {
      p_owner: ctx.owner, p_actor: ctx.actor, p_keys: ctx.keys, p_action: body.action,
      p_id: ["edit", "cancel"].includes(body.action) ? body.id : null,
      p_text: body.action === "edit" ? body.text.trim() : null, p_send_at: sendAt,
      p_access_revision: revision.data, p_expected_tags: expectedTags,
      p_allowed_properties: [...access.assignable].filter(([,house]) => house.ownerUserId === ctx.owner).map(([id]) => id),
    });
    if (result.error?.code === "42501") return NextResponse.json({ error: "You do not have permission to change this follow-up." }, { status: 403, headers });
    if (result.error) throw result.error;
    if (result.data === "started") return NextResponse.json({ error: "This text has already started sending and cannot be changed or cancelled." }, { status: 409, headers });
    if (result.data === "missing") return NextResponse.json({ error: "Follow-up not found." }, { status: 404, headers });
    if (result.data !== "ok") return NextResponse.json({ error: "The follow-up changed. Refresh and try again." }, { status: 409, headers });
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: "Could not update the follow-up." }, { status: 503, headers });
  }
}
