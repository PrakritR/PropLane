/**
 * Messaging tools: send a portal inbox message (optionally also email), schedule
 * a future send, and cancel a scheduled send. Recipient authorization always
 * goes through filterRecipientsBySenderScope — the same server-side gate the
 * interactive compose route uses — so the agent can never message anyone the
 * landlord couldn't message from the UI.
 */
import { z } from "zod";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { defineWriteTool } from "../registry";
import { withBodyWarnings } from "../preview-body";
import type { AgentContext } from "../context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import { filterRecipientsBySenderScope, type InboxScopeSender } from "@/lib/inbox-recipient-scope";
import { deliverPortalInboxMessage, resolveBroadcastRecipients } from "@/lib/portal-inbox-delivery";
import { MANAGER_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { smsInboxOwnerIds } from "@/lib/sms/manager-sms-access.server";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import {
  createScheduledInboxMessage,
  generateScheduledInboxMessageId,
  isResidentOriginatedScheduledRow,
  updateScheduledInboxMessage,
} from "@/lib/scheduled-inbox-messages";

const PREVIEW_LINE_CAP = 8;

/**
 * Tiny FNV-1a content hash for dedupe keys — only needs to make "the same
 * message to the same people" collide, nothing cryptographic.
 */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The sender identity handed to the scope filter — mirrors the interactive
 * send-inbox-message route's construction. Always from the authenticated
 * context, never from model input.
 */
function managerSender(ctx: AgentContext): InboxScopeSender {
  return { id: ctx.userId, email: ctx.email, role: "manager", isAdmin: false };
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

type ResolvedRecipient = { email: string; userId: string | null; name: string };

/** email -> display name from the landlord's own approved application records. */
async function residentNamesByEmail(ctx: AgentContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data } = await ctx.db
    .from("manager_application_records")
    .select("resident_email, row_data")
    .eq("manager_user_id", ctx.landlordId);
  for (const row of (data ?? []) as { resident_email: string | null; row_data: unknown }[]) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (rowData.bucket !== "approved") continue;
    const email = normalizeEmail(String(row.resident_email ?? rowData.email ?? ""));
    const name = String(rowData.name ?? rowData.residentName ?? "").trim();
    if (email && name && !out.has(email)) out.set(email, name);
  }
  return out;
}

/**
 * Resolve + authorize recipients from authoritative server data. Explicit
 * emails and the all-residents broadcast are merged, enriched with the
 * landlord's own approved-application names and matching profile ids, then
 * split by filterRecipientsBySenderScope. Out-of-scope recipients come back in
 * `blocked` so previews surface them instead of silently dropping them.
 */
async function resolveMessageRecipients(
  ctx: AgentContext,
  input: { toEmails?: string[]; toAllResidents?: boolean },
): Promise<{ allowed: ResolvedRecipient[]; blocked: ResolvedRecipient[] }> {
  const senderEmail = normalizeEmail(ctx.email);
  const byEmail = new Map<string, { email: string; userId: string | null }>();
  for (const raw of input.toEmails ?? []) {
    const email = normalizeEmail(raw);
    if (!email.includes("@") || email === senderEmail || byEmail.has(email)) continue;
    byEmail.set(email, { email, userId: null });
  }
  if (input.toAllResidents === true) {
    // Same broadcast expansion the send route's "All residents" chip uses,
    // resolved from the landlord's OWN approved application records.
    const residents = await resolveBroadcastRecipients(ctx.db, ctx.landlordId, ["resident"]);
    for (const r of residents) {
      if (r.email === senderEmail || byEmail.has(r.email)) continue;
      byEmail.set(r.email, { email: r.email, userId: r.userId });
    }
  }
  const candidates = [...byEmail.values()];
  if (candidates.length === 0) return { allowed: [], blocked: [] };

  // One profiles lookup attaches user ids (drives inbox scope + push at
  // delivery time); display names come from the landlord's own records.
  const { data: profiles } = await ctx.db
    .from("profiles")
    .select("id, email")
    .in("email", candidates.map((c) => c.email));
  const idByEmail = new Map(
    ((profiles ?? []) as { id: string; email: string | null }[]).map((p) => [
      normalizeEmail(String(p.email ?? "")),
      p.id,
    ]),
  );
  const nameByEmail = await residentNamesByEmail(ctx);
  const enriched: ResolvedRecipient[] = candidates.map((c) => ({
    email: c.email,
    userId: c.userId ?? idByEmail.get(c.email) ?? null,
    name: nameByEmail.get(c.email) ?? c.email,
  }));
  return filterRecipientsBySenderScope(ctx.db, managerSender(ctx), enriched);
}

function recipientLabel(r: { name: string; email: string }): string {
  return r.name === r.email ? r.email : `${r.name} (${r.email})`;
}

/** One phrasing for the channel set, shared by the preview and the reply. */
function describeDelivery(email: boolean, sms: boolean): string {
  const extra = [email ? "email" : null, sms ? "text" : null].filter(Boolean);
  return extra.length > 0 ? `Portal inbox + ${extra.join(" + ")}` : "Portal inbox only";
}

/**
 * A text lands on someone's phone, so the confirmer must see that the channel
 * escalated — an SMS is not undoable the way an unread inbox message is, and
 * the delivery layer only reaches verified, non-opted-out phones.
 */
function withSmsWarning(
  base: { warnings?: string[] },
  sms: boolean,
): { warnings?: string[] } {
  if (!sms) return base;
  const note =
    "This also sends a real text message. Only recipients with a verified phone who have not opted out will receive it.";
  return { warnings: [...(base.warnings ?? []), note] };
}

export const sendMessageTool = defineWriteTool({
  name: "send_message",
  description:
    "Send a message from the landlord to specific recipients by email and/or to all of their current residents at once, delivered to each recipient's portal inbox and optionally by email and/or SMS text. Recipients must be connected to the landlord (their residents, co-managers, or vendors) — get emails from list_residents or list_vendors. Use deliverViaSms when the landlord asks you to TEXT someone.",
  inputSchema: z
    .object({
      toEmails: z
        .array(z.string().min(3))
        .min(1)
        .max(20)
        .optional()
        .describe("Recipient email addresses (residents, co-managers, or vendors connected to this landlord)."),
      toAllResidents: z
        .boolean()
        .optional()
        .describe("When true, also send to every current (approved) resident in the landlord's portfolio."),
      subject: z.string().min(1).max(200).describe("Message subject line."),
      body: z.string().min(1).max(5000).describe("Message body (plain text)."),
      deliverViaEmail: z
        .boolean()
        .optional()
        .describe("Also send a real email to each recipient (default true). When false, delivers to portal inboxes only."),
      deliverViaSms: z
        .boolean()
        .optional()
        .describe(
          "Also text each recipient (default false). Only reaches recipients with a verified, non-opted-out phone; the rest still get the inbox copy. Use this when the landlord says to text someone.",
        ),
    })
    .strict(),
  preview: async (ctx, input) => {
    if (!input.toEmails?.length && input.toAllResidents !== true) {
      throw new Error("Provide toEmails and/or set toAllResidents: true.");
    }
    const { allowed, blocked } = await resolveMessageRecipients(ctx, input);
    if (allowed.length === 0) {
      throw new Error(blocked.length > 0
            ? `None of these recipients are connected to this landlord: ${blocked.map((b) => b.email).join(", ")}. Managers can only message their own residents, co-managers, and vendors.`
            : "No valid recipients resolved (the landlord has no approved residents to broadcast to).");
    }
    const subject = input.subject.trim();
    const body = input.body.trim();
    const deliverViaEmail = input.deliverViaEmail !== false;
    const deliverViaSms = input.deliverViaSms === true;

    const lines = allowed.slice(0, PREVIEW_LINE_CAP).map((r) => ({ label: r.name, value: r.email }));
    if (allowed.length > PREVIEW_LINE_CAP) {
      lines.push({ label: "…", value: `and ${allowed.length - PREVIEW_LINE_CAP} more` });
    }
    lines.push({ label: "Subject", value: subject });
    lines.push({ label: "Message", value: body });
    lines.push({ label: "Delivery", value: describeDelivery(deliverViaEmail, deliverViaSms) });
    if (blocked.length > 0) {
      // Surface — never silently drop — recipients the scope filter rejected.
      lines.push({ label: "Skipped (not connected)", value: blocked.map((b) => b.email).join(", ") });
    }

    // Normalized input: only in-scope explicit emails survive into the stored
    // action (the handler re-resolves and re-filters everything regardless).
    const explicit = new Set((input.toEmails ?? []).map(normalizeEmail));
    const allowedExplicit = allowed.filter((r) => explicit.has(r.email)).map((r) => r.email);
    return {
      confirmedInput: {
        ...(allowedExplicit.length > 0 ? { toEmails: allowedExplicit } : {}),
        ...(input.toAllResidents === true ? { toAllResidents: true } : {}),
        subject,
        body,
        ...(input.deliverViaEmail === undefined ? {} : { deliverViaEmail: input.deliverViaEmail }),
        ...(input.deliverViaSms === undefined ? {} : { deliverViaSms: input.deliverViaSms }),
      },
      kind: "send_message",
      title: allowed.length === 1 ? "Send message" : `Send message to ${allowed.length} recipients`,
      summary:
        (allowed.length === 1
          ? `Send "${subject}" to ${recipientLabel(allowed[0]!)}.`
          : `Send "${subject}" to ${allowed.length} recipients.`) +
        (blocked.length > 0
          ? ` ${blocked.length} requested recipient${blocked.length === 1 ? " is" : "s are"} not connected to you and will be skipped.`
          : ""),
      fields: lines,
      ...withSmsWarning(withBodyWarnings(body), deliverViaSms),
      confirmLabel: allowed.length === 1 ? "Send message" : `Send to ${allowed.length} recipients`,
      ...(allowed.length > 1 ? { batchCount: allowed.length } : {}),
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve + re-authorize every recipient at execute time — the stored
    // emails are never trusted as scope proof.
    const { allowed } = await resolveMessageRecipients(ctx, input);
    if (allowed.length === 0) {
      throw new Error("No authorized recipients remain for this message; nothing was sent.");
    }
    const subject = input.subject.trim();
    const body = input.body.trim();
    const deliverViaEmail = input.deliverViaEmail !== false;
    const deliverViaSms = input.deliverViaSms === true;
    const sortedEmails = allowed.map((r) => r.email).sort();

    // Record intent first, idempotent per identical content + recipient set
    // per day. Any other audit error fails loudly: never send unrecorded.
    const dedupeKey = `send_message:${ctx.landlordId}:${contentHash(`${subject}\n${body}\n${sortedEmails.join(",")}`)}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "send_message",
      toolName: "send_message",
      inputSummary: {
        recipientCount: allowed.length,
        broadcast: input.toAllResidents === true,
        deliverViaEmail,
        deliverViaSms,
      },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "This exact message already went to the same recipients today — not sending it again." };
      }
      throw new Error("Could not record the action; nothing was sent.");
    }

    // Sender display name from the landlord's own profile (recipients see it).
    const { data: senderProfile } = await ctx.db
      .from("profiles")
      .select("full_name")
      .eq("id", ctx.userId)
      .maybeSingle();
    const fromName = String(senderProfile?.full_name ?? "").trim() || ctx.email || "PropLane Portal";

    // Recipients with accounts go by user id (correct portal scope); emails
    // without a profile go by address. deliverPortalInboxMessage re-applies the
    // sender-scope filter internally — defense in depth.
    const toUserIds = allowed.filter((r) => r.userId).map((r) => r.userId!);
    const toEmails = allowed.filter((r) => !r.userId).map((r) => r.email);
    const delivery = await deliverPortalInboxMessage(ctx.db, {
      senderUserId: ctx.landlordId,
      senderEmail: ctx.email,
      fromName,
      subject,
      text: body,
      ...(toEmails.length > 0 ? { toEmails } : {}),
      ...(toUserIds.length > 0 ? { toUserIds } : {}),
      deliverViaEmail,
      deliverViaSms,
      senderRole: "manager",
    });
    if (!delivery.ok) {
      // Clear the dedupe key so a retry records a fresh attempt.
      await updateAuditResult(ctx, dedupeKey, { delivered: false }, { clearDedupeKey: true });
      throw new Error(delivery.error);
    }
    await updateAuditResult(ctx, dedupeKey, { delivered: true, recipientCount: delivery.recipientCount });
    return {
      reply: `Sent "${subject}" to ${delivery.recipientCount} recipient${delivery.recipientCount === 1 ? "" : "s"} (${describeDelivery(deliverViaEmail, deliverViaSms).toLowerCase()}).`,
      resultSummary: { recipientCount: delivery.recipientCount, deliverViaEmail, deliverViaSms },
    };
  },
});

type OwnThreadRow = {
  id: string;
  owner_user_id: string;
  participant_email: string | null;
  scope: string;
  row_data: PersistedInboxThread;
};

/** Load ONE inbox thread the actor can see (own or SMS-delegated owner). */
async function loadOwnInboxThread(ctx: AgentContext, threadId: string): Promise<OwnThreadRow | null> {
  const ownerIds = await smsInboxOwnerIds(ctx, "edit");
  for (const ownerId of ownerIds) {
    const { data, error } = await ctx.db
      .from("portal_inbox_thread_records")
      .select("id, owner_user_id, participant_email, scope, row_data")
      .eq("scope", MANAGER_INBOX_SCOPE)
      .eq("owner_user_id", ownerId)
      .eq("id", threadId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data as OwnThreadRow;
  }
  return null;
}

/** The counterparty address of a thread: sender for received mail, recipient for sent. */
function threadCounterpartyEmail(thread: PersistedInboxThread): string {
  return normalizeEmail(String(thread.email ?? ""));
}

export const replyToThreadTool = defineWriteTool({
  name: "reply_to_thread",
  description:
    "Reply to an existing inbox conversation: the reply is appended to the landlord's thread and delivered to the other person (resident, applicant, co-manager, or vendor) in their portal inbox and by email. Pass the thread id from list_inbox_threads or get_thread_messages; use get_thread_messages first to read what you are replying to.",
  inputSchema: z
    .object({
      threadId: z.string().min(1).describe("Inbox thread id from list_inbox_threads."),
      body: z.string().min(1).max(5000).describe("The reply text (plain text)."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const row = await loadOwnInboxThread(ctx, input.threadId);
    if (!row) {
      throw new Error(`No inbox thread ${input.threadId} for this landlord. Use list_inbox_threads to get valid thread ids.`);
    }
    const thread = row.row_data;
    if (thread.folder === "trash") {
      throw new Error("This thread is in the trash — restore it before replying.");
    }
    const counterparty = threadCounterpartyEmail(thread);
    if (!counterparty.includes("@")) {
      throw new Error("This thread has no reply address (it may be a system notification).");
    }
    // Same authorization gate as a fresh message: the counterparty must still
    // be connected to this landlord.
    const { allowed } = await resolveMessageRecipients(ctx, { toEmails: [counterparty] });
    const recipient = allowed[0];
    if (!recipient) {
      throw new Error(`${counterparty} is not connected to this landlord anymore, so this thread cannot be replied to.`);
    }
    const body = input.body.trim();
    const subject = thread.subject?.startsWith("Re:") ? thread.subject : `Re: ${thread.subject ?? ""}`.trim();
    const emailConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
    return {
      confirmedInput: { threadId: row.id, body },
      kind: "reply_to_thread",
      title: "Send reply",
      summary: `Reply to ${recipientLabel(recipient)} in "${thread.subject ?? "(no subject)"}".`,
      fields: [
          { label: "To", value: recipientLabel(recipient) },
          { label: "Subject", value: subject },
          { label: "Reply", value: body },
          {
            label: "Delivery",
            value: emailConfigured ? "Portal inbox + email" : "Portal inbox only (email is not configured)",
          },
        ],
      ...withBodyWarnings(body),
      confirmLabel: "Send reply",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve the thread AND re-authorize the counterparty at execute time.
    const row = await loadOwnInboxThread(ctx, input.threadId);
    if (!row) throw new Error("No inbox thread with that id for this landlord.");
    const thread = row.row_data;
    const counterparty = threadCounterpartyEmail(thread);
    const { allowed } = await resolveMessageRecipients(ctx, { toEmails: [counterparty] });
    const recipient = allowed[0];
    if (!recipient) {
      throw new Error("The other person in this thread is no longer connected to this landlord; nothing was sent.");
    }
    const body = input.body.trim();
    const subject = thread.subject?.startsWith("Re:") ? thread.subject : `Re: ${thread.subject ?? ""}`.trim();

    // Idempotent per identical reply per thread per day.
    const dedupeKey = `reply_to_thread:${ctx.landlordId}:${row.id}:${contentHash(body)}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "reply_to_thread",
      toolName: "reply_to_thread",
      inputSummary: { threadId: row.id, recipientEmail: recipient.email },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "This exact reply already went out on this thread today — not sending it again." };
      }
      throw new Error("Could not record the action; nothing was sent.");
    }

    const { data: senderProfile } = await ctx.db
      .from("profiles")
      .select("full_name")
      .eq("id", ctx.userId)
      .maybeSingle();
    const fromName = String(senderProfile?.full_name ?? "").trim() || ctx.email || "Property manager";

    // 1. Append the reply onto the landlord's own thread (same shape the
    //    interactive reply flow writes), so their inbox shows the exchange.
    const messages = Array.isArray(thread.messages) ? [...thread.messages] : [];
    const when = formatPacificDateTime(new Date());
    messages.push({
      id: `reply-${Date.now().toString(36)}`,
      from: fromName,
      body,
      at: when,
    });
    const { error: threadError } = await ctx.db.from("portal_inbox_thread_records").upsert(
      {
        id: row.id,
        scope: row.scope,
        owner_user_id: row.owner_user_id,
        participant_email: row.participant_email,
        row_data: {
          ...thread,
          messages,
          preview: body.slice(0, 100).replace(/\n/g, " "),
          time: when,
          unread: false,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (threadError) {
      await updateAuditResult(ctx, dedupeKey, { delivered: false }, { clearDedupeKey: true });
      throw new Error("Could not update the conversation; nothing was sent.");
    }

    // 2. Deliver the reply to the counterparty through the same scope-filtered
    //    pipeline as send_message. Degrades honestly to portal-only when email
    //    isn't configured — the portal thread is the primary channel.
    const emailConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
    const delivery = await deliverPortalInboxMessage(ctx.db, {
      senderUserId: ctx.landlordId,
      senderEmail: ctx.email,
      fromName,
      subject,
      text: body,
      ...(recipient.userId ? { toUserIds: [recipient.userId] } : { toEmails: [recipient.email] }),
      deliverViaEmail: emailConfigured,
      senderRole: "manager",
    });
    if (!delivery.ok) {
      await updateAuditResult(ctx, dedupeKey, { delivered: false }, { clearDedupeKey: true });
      throw new Error(delivery.error);
    }
    await updateAuditResult(ctx, dedupeKey, { delivered: true, emailed: emailConfigured });
    return { reply: `Replied to ${recipientLabel(recipient)} on "${thread.subject ?? "(no subject)"}" ${emailConfigured ? "(portal inbox + email)" : "(portal inbox only — email is not configured)"}.`, resultSummary: { threadId: row.id } };
  },
});

function parseFutureSendAt(sendAtIso: string): { ok: true; iso: string } | { ok: false; error: string } {
  const at = new Date(sendAtIso);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, error: `"${sendAtIso}" is not a valid ISO 8601 datetime.` };
  }
  if (at.getTime() <= Date.now()) {
    return { ok: false, error: "sendAtIso must be in the future — for an immediate send use send_message instead." };
  }
  return { ok: true, iso: at.toISOString() };
}

export const scheduleMessageTool = defineWriteTool({
  name: "schedule_message",
  description:
    "Schedule a message from the landlord to one connected recipient (resident, co-manager, or vendor) to be delivered at a future date/time instead of immediately. For immediate delivery use send_message; scheduled messages appear in list_scheduled_messages.",
  inputSchema: z
    .object({
      toEmail: z.string().min(3).max(200).describe("Recipient email address — someone connected to this landlord."),
      subject: z.string().min(1).max(200).describe("Message subject line."),
      body: z.string().min(1).max(5000).describe("Message body (plain text)."),
      sendAtIso: z.string().min(1).describe("Future ISO 8601 datetime at which to send the message."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const when = parseFutureSendAt(input.sendAtIso);
    if (!when.ok) throw new Error(when.error);
    const { allowed } = await resolveMessageRecipients(ctx, { toEmails: [input.toEmail] });
    const recipient = allowed[0];
    if (!recipient) {
      throw new Error(`${normalizeEmail(input.toEmail)} is not connected to this landlord. Managers can only message their own residents, co-managers, and vendors.`);
    }
    const subject = input.subject.trim();
    const body = input.body.trim();
    return {
      confirmedInput: { toEmail: recipient.email, subject, body, sendAtIso: when.iso },
      kind: "schedule_message",
      title: "Schedule message",
      summary: `Schedule "${subject}" to ${recipientLabel(recipient)} for ${when.iso}.`,
      fields: [
          { label: "To", value: recipientLabel(recipient) },
          { label: "Subject", value: subject },
          { label: "Message", value: body },
          { label: "Send at", value: when.iso },
          { label: "Delivery", value: "Portal inbox + email" },
        ],
      ...withBodyWarnings(body),
      confirmLabel: "Schedule message",
    };
  },
  handler: async (ctx, input) => {
    const when = parseFutureSendAt(input.sendAtIso);
    if (!when.ok) throw new Error(when.error);
    // Re-authorize the recipient at execute time.
    const { allowed } = await resolveMessageRecipients(ctx, { toEmails: [input.toEmail] });
    const recipient = allowed[0];
    if (!recipient) {
      throw new Error("This recipient is no longer connected to this landlord; nothing was scheduled.");
    }
    const subject = input.subject.trim();
    const body = input.body.trim();

    // One-shot per (recipient, send time, subject): retries return already-done.
    const dedupeKey = `schedule_message:${ctx.landlordId}:${recipient.email}:${when.iso}:${contentHash(subject)}`;
    const audit = await writeAuditLog(ctx, {
      action: "schedule_message",
      toolName: "schedule_message",
      inputSummary: { recipientEmail: recipient.email, sendAt: when.iso },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `A message with this subject is already scheduled to ${recipient.email} for ${when.iso}.` };
      }
      throw new Error("Could not record the action; nothing was scheduled.");
    }

    const id = generateScheduledInboxMessageId();
    try {
      await createScheduledInboxMessage(ctx.db, {
        id,
        managerUserId: ctx.landlordId,
        sendAt: when.iso,
        status: "scheduled",
        subject,
        body,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        recipientUserId: recipient.userId,
        deliverViaEmail: true,
        deliverViaSms: false,
        senderPortal: "manager",
      });
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { scheduled: false }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The message could not be scheduled.");
    }
    await updateAuditResult(ctx, dedupeKey, { scheduledId: id });
    return { reply: `Scheduled "${subject}" to ${recipientLabel(recipient)} for ${when.iso}.`, resultSummary: { scheduledId: id, sendAt: when.iso } };
  },
});

type ScheduledRow = { id: string; send_at: string; status: string; row_data: unknown };

/** Load ONE of the landlord's own scheduled messages, or null. */
async function loadOwnScheduledMessage(ctx: AgentContext, messageId: string): Promise<ScheduledRow | null> {
  const { data, error } = await ctx.db
    .from("portal_scheduled_inbox_message_records")
    .select("id, send_at, status, row_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", messageId)
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ScheduledRow[])[0] ?? null;
}

export const cancelScheduledMessageTool = defineWriteTool({
  name: "cancel_scheduled_message",
  description:
    "Cancel one of the landlord's own not-yet-sent scheduled messages so it never goes out. Pass the message id from list_scheduled_messages.",
  inputSchema: z
    .object({
      messageId: z.string().min(1).describe("Scheduled message id from list_scheduled_messages."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const row = await loadOwnScheduledMessage(ctx, input.messageId);
    if (!row) {
      throw new Error(`No scheduled message ${input.messageId} for this landlord. Use list_scheduled_messages to get valid ids.`);
    }
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (isResidentOriginatedScheduledRow(rowData)) {
      throw new Error("This message was scheduled by a resident; managers cannot cancel it.");
    }
    if (row.status === "sent") {
      throw new Error("This scheduled message was already sent and can no longer be cancelled.");
    }
    if (row.status === "cancelled") {
      throw new Error("This scheduled message is already cancelled.");
    }
    const subject = String(rowData.subject ?? "").trim() || "(no subject)";
    const recipientEmail = normalizeEmail(String(rowData.recipientEmail ?? ""));
    const recipientName = String(rowData.recipientName ?? "").trim() || recipientEmail;
    return {
      kind: "cancel_scheduled_message",
      title: "Cancel scheduled message",
      summary: `Cancel the scheduled message "${subject}" to ${recipientName} (was set to send at ${row.send_at}).`,
      fields: [
          { label: "To", value: recipientLabel({ name: recipientName, email: recipientEmail }) },
          { label: "Subject", value: subject },
          { label: "Send at", value: row.send_at },
        ],
      confirmLabel: "Cancel message",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve under the landlord scope — the stored id is never trusted.
    const row = await loadOwnScheduledMessage(ctx, input.messageId);
    if (!row) throw new Error("No scheduled message with that id for this landlord.");
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    if (isResidentOriginatedScheduledRow(rowData)) {
      throw new Error("This message was scheduled by a resident; managers cannot cancel it.");
    }
    if (row.status === "sent") {
      throw new Error("This scheduled message was already sent and can no longer be cancelled.");
    }
    const subject = String(rowData.subject ?? "").trim() || "(no subject)";
    const recipientEmail = normalizeEmail(String(rowData.recipientEmail ?? ""));
    if (row.status === "cancelled") {
      return { reply: `The scheduled message "${subject}" was already cancelled.` };
    }

    // One-shot state transition: repeats return already-done forever.
    const dedupeKey = `cancel_scheduled_message:${ctx.landlordId}:${row.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "cancel_scheduled_message",
      toolName: "cancel_scheduled_message",
      inputSummary: { messageId: row.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `The scheduled message "${subject}" was already cancelled.` };
      throw new Error("Could not record the action; the message is still scheduled.");
    }
    try {
      // The lib re-checks (id, manager_user_id) ownership on its own read.
      await updateScheduledInboxMessage(ctx.db, ctx.landlordId, row.id, {
        status: "cancelled",
        cancelledAt: new Date().toISOString(),
      });
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { cancelled: false }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The scheduled message could not be cancelled.");
    }
    await updateAuditResult(ctx, dedupeKey, { cancelled: true });
    return { reply: `Cancelled the scheduled message "${subject}" to ${recipientEmail || "the recipient"} (was set for ${row.send_at}).`, resultSummary: { messageId: row.id } };
  },
});
