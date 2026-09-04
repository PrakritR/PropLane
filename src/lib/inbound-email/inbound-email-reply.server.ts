/**
 * Emailed replies → portal conversation threads.
 *
 * When an inbound email's To carries a verified reply token
 * (reply-address.server.ts), the reply belongs to a portal conversation, not
 * the admin support inbox. This module appends it to BOTH sides of the
 * person-thread — the token owner's inbox copy (unread, inbound) and the
 * replier's own inbox copy (outbound, so their portal thread shows what they
 * sent by email) — via the same `deliverPortalMessageThreadSide` primitive the
 * portal send paths use.
 *
 * Durability posture mirrors the support-inbox ingest
 * (inbound-email.server.ts): the append runs INLINE from webhook metadata with
 * a placeholder body when Resend sent metadata only (a throwing append 500s
 * the route so Resend redelivers), and the body is filled in by a best-effort
 * after() pass. Idempotency is the deterministic message id
 * `email_<resend-email-id>` — `deliverPortalMessageThreadSide` skips an append
 * whose id already landed, which also makes a redelivery after a partial
 * (one-of-two-rows) append safe.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  clampBody,
  fetchResendReceivedEmailBodyWithRetry,
  htmlToText,
  INBOUND_EMAIL_BODY_PLACEHOLDER,
  type ParsedInboundEmail,
} from "@/lib/inbound-email/inbound-email.server";
import {
  deliverPortalMessageThreadSide,
  findExistingPortalMessageThread,
  scopeForRole,
  type PortalMessageThreadSide,
} from "@/lib/portal-inbox-delivery";
import { inboxDeepLinkForRole } from "@/lib/platform/parity";
import { sendPushToUser } from "@/lib/push-notifications.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export function inboundReplyMessageId(emailId: string): string {
  return `email_${emailId.trim()}`;
}

/**
 * Trim quoted history from an email reply so the chat bubble carries only the
 * new text: drop everything from the first quote marker ("On … wrote:",
 * "-----Original Message-----", a From:-header block) and any `>`-quoted
 * lines. Heuristic on purpose — when stripping would empty the body, the full
 * body is kept rather than losing the reply.
 */
export function stripEmailReplyQuote(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^On .{4,80} wrote:\s*$/.test(trimmed) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(trimmed) ||
      /^From:\s.+@.+/i.test(trimmed)
    ) {
      break;
    }
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  const stripped = kept.join("\n").trim();
  return stripped || body.trim();
}

function bestInlineBody(parsed: ParsedInboundEmail): string {
  if (parsed.text?.trim()) return clampBody(stripEmailReplyQuote(parsed.text));
  if (parsed.html?.trim()) return clampBody(stripEmailReplyQuote(htmlToText(parsed.html)));
  return "";
}

function displayWhen(receivedAt: string): string {
  const at = new Date(receivedAt);
  const date = Number.isNaN(at.getTime()) ? new Date() : at;
  return formatPacificDateTime(date);
}

/** The two thread sides one reply writes to, shared by ingest and backfill. */
async function replyThreadSides(
  db: SupabaseClient,
  parsed: ParsedInboundEmail,
  ownerUserId: string,
): Promise<{ owner: PortalMessageThreadSide; replier: PortalMessageThreadSide; ownerRole: string | null } | null> {
  const { data: ownerProfile } = await db
    .from("profiles")
    .select("email, role")
    .eq("id", ownerUserId)
    .maybeSingle();
  const ownerEmail = String(ownerProfile?.email ?? "").trim().toLowerCase();
  if (!ownerEmail) return null;

  const from = parsed.fromEmail.trim().toLowerCase();
  const { data: replierProfile } = await db
    .from("profiles")
    .select("id, role")
    .eq("email", from)
    .maybeSingle();

  return {
    ownerRole: String(ownerProfile?.role ?? "") || null,
    owner: {
      scope: scopeForRole(String(ownerProfile?.role ?? "") || null),
      folder: "inbox",
      ownerUserId,
      participantEmail: ownerEmail,
      otherPartyEmail: from,
    },
    replier: {
      scope: scopeForRole(replierProfile ? String(replierProfile.role ?? "") || null : null),
      folder: "inbox",
      ownerUserId: (replierProfile?.id as string | undefined) ?? null,
      participantEmail: from,
      otherPartyEmail: ownerEmail,
    },
  };
}

/**
 * Append an emailed reply to both sides of the portal conversation. Returns
 * `handled: false` when the token owner no longer resolves to a profile — the
 * caller falls back to the admin support ingest so the mail stays visible.
 * Any database error throws so the webhook can 5xx and Resend redelivers.
 */
export async function ingestInboundEmailReply(
  parsed: ParsedInboundEmail,
  ownerUserId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<{ handled: boolean; appended: boolean; body: string }> {
  const sides = await replyThreadSides(db, parsed, ownerUserId);
  if (!sides) return { handled: false, appended: false, body: "" };

  const body = bestInlineBody(parsed) || INBOUND_EMAIL_BODY_PLACEHOLDER;
  const messageId = inboundReplyMessageId(parsed.emailId);
  const fromName = parsed.fromName || parsed.fromEmail;
  const subject = parsed.subject || "(no subject)";
  const preview = body.slice(0, 100).replace(/\n/g, " ");
  const when = displayWhen(parsed.receivedAt);
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);

  // Owner's inbox copy — where an in-portal reply from this person would land.
  const ownerResult = await deliverPortalMessageThreadSide(db, {
    ...sides.owner,
    fallbackId: `msg_inbox_${ts}_${rand}`,
    fromName,
    subject,
    body,
    preview,
    when,
    unread: true,
    outbound: false,
    messageId,
  });

  // Replier's own copy of the conversation shows the reply they emailed.
  await deliverPortalMessageThreadSide(db, {
    ...sides.replier,
    fallbackId: `msg_inbox_${ts}_${rand}r`,
    fromName,
    subject,
    body,
    preview,
    when,
    unread: false,
    outbound: true,
    messageId,
  });
  const appended = ownerResult.action !== "skipped";

  if (appended) {
    // Best-effort push, same generic payload as the portal send route (message
    // bodies can carry sensitive lease/payment details).
    await sendPushToUser(ownerUserId, {
      title: `New message from ${fromName}`,
      body: "You have a new message in your PropLane inbox.",
      url: inboxDeepLinkForRole(sides.ownerRole),
    }).catch(() => {});
  }

  // `body` is surfaced so the caller can act on what was actually appended
  // (PRP-109 files a work order from it) without re-deriving it from `parsed`.
  return { handled: true, appended, body };
}

/**
 * Best-effort after() pass that swaps the placeholder reply body for the real
 * one once Resend's received-email API answers. Same shape as
 * `backfillInboundEmailBody`: the slow lookup runs before the fresh
 * read→write pair, and only a message still holding the placeholder is
 * touched, so an admin/manager edit or a faster backfill is never clobbered.
 */
/** Does this thread row still hold the reply's placeholder body? */
function holdsPlaceholder(rowData: Record<string, unknown>, messageId: string): boolean {
  if (rowData.rootMessageId === messageId && rowData.body === INBOUND_EMAIL_BODY_PLACEHOLDER) return true;
  const messages = Array.isArray(rowData.messages) ? (rowData.messages as unknown[]) : [];
  return messages.some((m) => {
    const msg = m as { id?: unknown; body?: unknown } | null;
    return msg?.id === messageId && msg.body === INBOUND_EMAIL_BODY_PLACEHOLDER;
  });
}

export async function backfillInboundEmailReplyBody(
  parsed: ParsedInboundEmail,
  ownerUserId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<{ updated: boolean }> {
  if (bestInlineBody(parsed)) return { updated: false };

  const sides = await replyThreadSides(db, parsed, ownerUserId);
  if (!sides) return { updated: false };
  const messageId = inboundReplyMessageId(parsed.emailId);

  // Cheap pre-check so an already-enriched reply (idempotent redelivery) never
  // costs a Resend round trip. The slow lookup stays OUTSIDE the fresh
  // read→write pair below, mirroring backfillInboundEmailBody.
  const sideList = [sides.owner, sides.replier];
  const precheck = await Promise.all(sideList.map((side) => findExistingPortalMessageThread(db, side)));
  if (!precheck.some((row) => row && holdsPlaceholder(row.rowData, messageId))) {
    return { updated: false };
  }

  const fetched = await fetchResendReceivedEmailBodyWithRetry(parsed.emailId);
  if (fetched.kind !== "body") return { updated: false };
  const body = clampBody(stripEmailReplyQuote(fetched.text));
  if (!body) return { updated: false };

  const preview = body.slice(0, 100).replace(/\n/g, " ");
  const placeholderPreview = INBOUND_EMAIL_BODY_PLACEHOLDER.slice(0, 100).replace(/\n/g, " ");

  let updated = false;
  for (const side of sideList) {
    const row = await findExistingPortalMessageThread(db, side);
    if (!row) continue;
    const rowData = { ...row.rowData };
    let changed = false;

    if (rowData.rootMessageId === messageId && rowData.body === INBOUND_EMAIL_BODY_PLACEHOLDER) {
      rowData.body = body;
      changed = true;
    }
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as unknown[])] : [];
    const idx = messages.findIndex((m) => {
      const msg = m as { id?: unknown; body?: unknown } | null;
      return msg?.id === messageId && msg.body === INBOUND_EMAIL_BODY_PLACEHOLDER;
    });
    if (idx >= 0) {
      messages[idx] = { ...(messages[idx] as Record<string, unknown>), body };
      rowData.messages = messages;
      changed = true;
    }
    if (!changed) continue;
    if (rowData.preview === placeholderPreview) rowData.preview = preview;

    // Optimistic guard: these are LIVE conversations, so a snapshot write-back
    // could swallow a message appended mid-backfill. Matching on the read
    // updated_at makes this write lose instead — the body simply stays the
    // placeholder (recoverable), never a lost message.
    let query = db
      .from("portal_inbox_thread_records")
      .update({ row_data: rowData, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (row.updatedAt) query = query.eq("updated_at", row.updatedAt);
    const { error } = await query;
    if (error) {
      console.warn("inbound-email reply body backfill failed", parsed.emailId, error.message);
      continue;
    }
    updated = true;
  }
  return { updated };
}
