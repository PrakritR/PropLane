import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
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
import {
  dispatchOwnerSmsOutbox,
  enqueueOwnerSms,
} from "@/lib/sms/owner-sms-dispatcher.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { track } from "@/lib/analytics/posthog";
import { MANUAL_SMS_UNKNOWN_MESSAGE } from "@/lib/sms/manual-send-attempt";

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
export async function GET() {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  try {
    const payload = await fetchManagerSmsConversations(auth.db, auth.user.id);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to load SMS conversations.";
    return NextResponse.json({ error: message }, { status: 500 });
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
  };
  const phone = normalizeE164(String(body.phone ?? "").trim());
  const requestedKey = String(body.conversationKey ?? "").trim();
  if (!phone)
    return NextResponse.json(
      { error: "Enter a valid phone number." },
      { status: 400 },
    );

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
  };
  const text = String(body.text ?? "").trim();
  if (!text)
    return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  if (text.length > 1600) {
    return NextResponse.json(
      { error: "Message is too long (max 1600 characters)." },
      { status: 400 },
    );
  }

  const toPhone = normalizeE164(String(body.toPhone ?? "").trim());
  if (!toPhone)
    return NextResponse.json(
      { error: "Enter a valid US phone number." },
      { status: 400 },
    );

  const conversations = await fetchManagerSmsConversations(
    auth.db,
    auth.user.id,
  );
  const toDigits = toPhone.replace(/\D/g, "");
  const replyKey = String(body.conversationKey ?? "").trim();
  // One phone can be two threads. When the client says which one it is replying
  // into, honour that — otherwise a reply typed in the prospect thread gets
  // stamped `resident` (or vice versa) and lands in the other conversation.
  const match =
    (replyKey
      ? conversations.residents.find((r) => r.conversationKey === replyKey)
      : null) ??
    conversations.residents.find((r) => {
      const phoneDigits = String(r.phone ?? "").replace(/\D/g, "");
      if (
        phoneDigits &&
        (phoneDigits === toDigits || phoneDigits.endsWith(toDigits.slice(-10)))
      )
        return true;
      if (body.residentUserId && r.residentUserId === body.residentUserId)
        return true;
      return false;
    });

  if (!match) {
    return NextResponse.json(
      {
        error:
          "Choose a resident or applicant who has opted in to PropLane texts.",
      },
      { status: 409 },
    );
  }

  // The conversation supplies the authoritative destination. A browser may
  // identify a visible thread, but it may not pair that thread's resident id,
  // email or consent evidence with a different phone number.
  const matchedPhone = normalizeE164(String(match.phone ?? "").trim());
  if (!matchedPhone || matchedPhone !== toPhone) {
    return NextResponse.json(
      { error: "The recipient no longer matches this conversation. Refresh and try again." },
      { status: 409 },
    );
  }

  // The server-resolved conversation also owns manager/co-manager scope.
  const ownerManagerUserId =
    String(match.ownerManagerUserId ?? auth.user.id).trim() || auth.user.id;
  if (ownerManagerUserId !== auth.user.id) {
    const editScope = await resolveSmsScopeManagerIds(
      auth.db,
      auth.user.id,
      "edit",
    );
    if (!editScope.includes(ownerManagerUserId)) {
      return NextResponse.json(
        { error: "You do not have edit access to this conversation." },
        { status: 403 },
      );
    }
  }
  const requestedDedupe = req.headers.get("idempotency-key")?.trim() ?? "";
  const dedupeKey = /^[A-Za-z0-9_-]{16,128}$/.test(requestedDedupe)
    ? `manager:${requestedDedupe}`
    : `manager:${createHash("sha256")
        .update(
          [
            auth.user.id,
            ownerManagerUserId,
            toPhone,
            match?.conversationKey ?? replyKey,
            text,
            Math.floor(Date.now() / 30_000),
          ].join("|"),
        )
        .digest("hex")}`;
  const result = await enqueueOwnerSms({
    managerUserId: ownerManagerUserId,
    actorUserId: auth.user.id,
    recipientPhone: matchedPhone,
    recipientEmail: match?.residentEmail ?? null,
    body: text,
    sendClass: "transactional",
    purpose: "manager_conversation",
    conversationKey: (match?.conversationKey ?? replyKey) || null,
    counterpartyRole: match?.counterpartyRole,
    // Never persist a browser-supplied identity on a cold compose. A linked
    // user id is accepted only after the server matched it to a visible thread.
    recipientUserId: match?.residentUserId ?? null,
    dedupeKey,
  });

  if (!result.ok) {
    const userMessage =
      result.error === "recipient_opted_out"
        ? "That number has opted out of texts."
        : result.error === "scoped_consent_missing"
          ? "That person must text your work number or opt in before you can reply."
          : result.error.startsWith("entitlement_")
            ? "Messaging requires an active paid plan."
            : result.error.includes("runtime") ||
                result.error.includes("number_") ||
                result.error.includes("provider_")
              ? "Your work number is not ready to send yet. Open Settings → Messaging for details."
              : "Could not queue SMS.";
    return NextResponse.json(
      { error: userMessage },
      { status: result.error === "scoped_consent_missing" ? 409 : 503 },
    );
  }

  const dispatch = await dispatchOwnerSmsOutbox(
    {
      workerId: `manager-route-${auth.user.id}`,
      outboxId: result.outboxId,
    },
    auth.db,
  );
  const { data: outbox } = await auth.db
    .from("sms_outbox")
    .select("status, blocked_reason")
    .eq("id", result.outboxId)
    .maybeSingle();
  const outboxStatus = String(outbox?.status ?? result.status);
  if (outboxStatus === "unknown" || dispatch.unknown > 0) {
    return NextResponse.json(
      {
        code: "delivery_outcome_unknown",
        error: MANUAL_SMS_UNKNOWN_MESSAGE,
        outboxId: result.outboxId,
        status: "unknown",
      },
      { status: 409 },
    );
  }
  if (outboxStatus === "blocked" || outboxStatus === "failed") {
    return NextResponse.json(
      {
        error:
          "The SMS could not be submitted. Check Settings → Messaging and try again.",
        outboxId: result.outboxId,
      },
      { status: 503 },
    );
  }
  const responseStatus =
    dispatch.submitted === 1 ||
    ["submitted", "sent", "delivered"].includes(outboxStatus)
      ? "submitted"
      : outboxStatus;
  if (responseStatus === "submitted") {
    track("message_sent", auth.user.id, {
      channel: "sms",
      owner_id: ownerManagerUserId,
    });
  }
  return NextResponse.json(
    {
      ok: true,
      outboxId: result.outboxId,
      status: responseStatus,
    },
    { status: responseStatus === "submitted" ? 200 : 202 },
  );
}
