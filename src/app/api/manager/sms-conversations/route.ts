import { NextResponse } from "next/server";
import {
  deleteManagerSmsConversation,
  fetchManagerSmsConversations,
  resolveSmsScopeManagerIds,
} from "@/lib/manager-sms-messages.server";
import {
  getPortalAccessContext,
  hasAdminRole,
  hasRole,
} from "@/lib/auth/portal-access";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { decodeSmsProjectionCursor, fetchManagerSmsProjectionDetail, fetchManagerSmsProjectionPage } from "@/lib/sms/sms-projection-inbox.server";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

export const runtime = "nodejs";

async function requireManager() {
  const ctx = await getPortalAccessContext();
  const user = ctx.user;
  if (!user)
    return {
      error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }),
    };
  if (!hasRole(ctx, "manager") && !hasAdminRole(ctx)) {
    return {
      error: NextResponse.json(
        { error: "Manager access required." },
        { status: 403 },
      ),
    };
  }
  const db = createSupabaseServiceRoleClient();
  return { user, db, profile: ctx.profile };
}

/** Manager Communication → SMS: work number + per-resident inbound/outbound texts. */
export async function GET(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  try {
    const { data: cutover } = await auth.db.from("sms_projection_cutover").select("ready").eq("singleton", true).maybeSingle();
    if (cutover?.ready !== true) {
      const legacy = await fetchManagerSmsConversations(auth.db, auth.user.id);
      return NextResponse.json({ ...legacy, nextCursor: null, projectionReady: false }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const before = decodeSmsProjectionCursor(new URL(req.url).searchParams.get("before"));
    const payload = await fetchManagerSmsProjectionPage(auth.db, auth.user.id, before);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to load SMS conversations.";
    return NextResponse.json({ error: message }, { status: message === "Invalid conversation cursor." ? 400 : 500 });
  }
}

/**
 * Delete ONE conversation's stored texts. The client sends the conversation
 * key alongside the phone: one phone can be two threads (prospect + resident)
 * and this is an irreversible hard delete, so the key — not the number — picks
 * the victim.
 */
export async function DELETE(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as {
    phone?: string;
    conversationKey?: string;
    projectionId?: string;
  };
  const phone = normalizeE164(String(body.phone ?? "").trim());
  const requestedKey = String(body.conversationKey ?? "").trim();
  if (!phone)
    return NextResponse.json(
      { error: "Enter a valid phone number." },
      { status: 400 },
    );

  if (body.projectionId) {
    const projectionId = String(body.projectionId).trim();
    if (!/^[0-9a-f-]{36}$/i.test(projectionId)) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    const detail = await fetchManagerSmsProjectionDetail(auth.db, auth.user.id, projectionId, null, "delete");
    if (!detail || normalizeE164(detail.resident.phone ?? "") !== phone) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    const ownerManagerUserId = String(detail.resident.ownerManagerUserId ?? "");
    if (!ownerManagerUserId) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    const { data: deleted, error: deleteError } = await auth.db.rpc("delete_sms_projection_conversation", {
      p_owner: ownerManagerUserId,
      p_conversation: detail.resident.projectionId,
      p_actor: auth.user.id,
    });
    if (deleteError) return NextResponse.json({ error: "Could not delete conversation." }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: Number(deleted ?? 0) });
  }

  const { data: cutover } = await auth.db.from("sms_projection_cutover").select("ready").eq("singleton", true).maybeSingle();
  if (cutover?.ready === true) {
    return NextResponse.json({ error: "Reload this conversation before deleting it." }, { status: 409 });
  }

  const conversations = await fetchManagerSmsConversations(
    auth.db,
    auth.user.id,
  );
  const digits = phone.replace(/\D/g, "");
  const phoneMatches = (r: (typeof conversations.residents)[number]) => {
    const phoneDigits = String(r.phone ?? "").replace(/\D/g, "");
    return Boolean(
      phoneDigits &&
      (phoneDigits === digits || phoneDigits.endsWith(digits.slice(-10))),
    );
  };
  // A key must resolve to a real conversation the viewer can see, so it can
  // never be used to reach rows outside the scope this GET already authorizes.
  // A member key resolves too: the thread the client is looking at may have
  // been keyed under any of the keys the read path merged into it.
  const match = requestedKey
    ? conversations.residents.find(
        (r) =>
          r.conversationKey === requestedKey ||
          (r.memberKeys ?? []).includes(requestedKey),
      )
    : conversations.residents.find(phoneMatches);
  if (!match) {
    return NextResponse.json(
      { error: "Conversation not found." },
      { status: 404 },
    );
  }

  const ownerManagerUserId =
    String(match.ownerManagerUserId ?? auth.user.id).trim() || auth.user.id;
  // Deleting an owner's conversation needs a delete-level inbox grant —
  // read-level co-manager access only allows viewing, edit allows replies.
  if (ownerManagerUserId !== auth.user.id) {
    const deleteScope = await resolveSmsScopeManagerIds(
      auth.db,
      auth.user.id,
      "delete",
    );
    if (!deleteScope.includes(ownerManagerUserId)) {
      return NextResponse.json(
        { error: "You do not have delete access to this conversation." },
        { status: 403 },
      );
    }
  }

  const result = await deleteManagerSmsConversation(auth.db, {
    managerUserId: ownerManagerUserId,
    phone: match.phone?.trim() || phone,
    conversationKey: match.conversationKey ?? null,
    // The thread on screen is a merge of these keys — all of them are the
    // conversation the manager just confirmed deleting.
    conversationKeys: match.memberKeys ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: "Could not delete conversation." },
      { status: 500 },
    );
  }
  if (result.partial) {
    // Some texts are already irreversibly gone — say so instead of reporting a
    // clean success the manager would trust, or a failure they would retry.
    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      partial: true,
      error: "Some texts in this conversation could not be deleted. Try again.",
    });
  }
  return NextResponse.json({ ok: true, deleted: result.deleted });
}

/** Send a new SMS from the PropLane messaging number (Claw agent line). */
export async function POST(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as {
    toPhone?: string;
    text?: string;
    residentUserId?: string | null;
    conversationKey?: string | null;
    projectionId?: string | null;
  };
  let selectedConversation: ManagerSmsResidentConversation | undefined;
  if (body.projectionId) {
    const detail = await fetchManagerSmsProjectionDetail(auth.db, auth.user.id, String(body.projectionId), null, "edit");
    if (!detail || normalizeE164(detail.resident.phone ?? "") !== normalizeE164(String(body.toPhone ?? ""))) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    if (detail.resident.sendDisabled) {
      return NextResponse.json({ error: "This historical conversation cannot be replied to from a work number." }, { status: 409 });
    }
    selectedConversation = detail.resident;
  }
  const result = await sendManagerConversationSms(auth.db, {
    actorUserId: auth.user.id,
    toPhone: body.toPhone,
    text: body.text,
    residentUserId: body.residentUserId,
    conversationKey: body.conversationKey,
    selectedConversation,
    idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
  });
  return NextResponse.json(result.body, { status: result.status });
}
