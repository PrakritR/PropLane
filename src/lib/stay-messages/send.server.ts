import "server-only";

/**
 * The real ports of the stay-message sweep (design-1112 §7): the `stay_message_sends` ledger, the three channels and the
 * manager flag. SMS + email + in-app for every stay with contact details; each channel's outcome is recorded on the ledger
 * row so a retry only sends what did not deliver, and every send carries one deterministic key.
 *
 * Note (§5 item 5): `noticeChannelFor` says a portal row is never texted. The captain's "all three channels" overrides it for
 * these two messages only; nothing else reads this module.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { deliverManagerEmailReply } from "@/lib/agent/manager-email-agent.server";
import { resolveHouseSmsLine } from "@/lib/house-message-send.server";
import { loadManagerAssistantEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { deliverPortalInboxMessage, deliverPortalMessageThreadSide, scopeForRole } from "@/lib/portal-inbox-delivery";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { recordDeliveryIssue, resolveSmsPayer } from "@/lib/prospect-spine/index.server";
import { sendAsPropLaneAfterRefusal } from "@/lib/prospect-spine/payer.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { notifyServiceAlertTargets } from "@/lib/service/service-alert-targets.server";
import { loadStayCandidates, loadStayMessageSettings, loadStayProperty } from "@/lib/stay-messages/facts.server";
import { runStayMessageSweep } from "@/lib/stay-messages/sweep.server";
import type {
  ChannelResults,
  LedgerInsert,
  LedgerRow,
  StayHoldReason,
  StayMessageDeps,
  StayMessageKind,
  StayMessageLedger,
  StayMessageSendInput,
  StayMessageStatus,
  StayMessageSweepSummary,
} from "@/lib/stay-messages/types";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function mapRow(raw: Row): LedgerRow {
  return {
    id: str(raw.id),
    stayKey: str(raw.stay_key),
    kind: str(raw.kind) as StayMessageKind,
    status: str(raw.status) as StayMessageStatus,
    holdReason: (str(raw.hold_reason) || null) as StayHoldReason | null,
    dueAt: str(raw.due_at),
    sentAt: str(raw.sent_at) || null,
    roomId: str(raw.room_id) || null,
    factsHash: str(raw.facts_hash) || null,
    channels: raw.channels && typeof raw.channels === "object" ? (raw.channels as ChannelResults) : {},
    threadId: str(raw.thread_id) || null,
    updatedAt: str(raw.updated_at),
  };
}

export function createStayMessageLedger(db: SupabaseClient): StayMessageLedger {
  return {
    async find(stayKey, kind, factsHash) {
      let query = db.from("stay_message_sends").select("*").eq("stay_key", stayKey).eq("kind", kind);
      if (kind === "check_in_correction" && factsHash) query = query.eq("facts_hash", factsHash);
      const { data, error } = await query.order("created_at", { ascending: false }).limit(1);
      if (error) throw error;
      const raw = ((data ?? []) as Row[])[0];
      return raw ? mapRow(raw) : null;
    },
    async insert(input: LedgerInsert) {
      const { data, error } = await db
        .from("stay_message_sends")
        .insert({
          workspace_id: input.workspaceId,
          stay_key: input.stayKey,
          kind: input.kind,
          status: input.status,
          hold_reason: input.holdReason ?? null,
          due_at: input.dueAt,
          room_id: input.roomId,
          facts_hash: input.factsHash,
        })
        .select("*")
        .maybeSingle();
      if (error) {
        // The unique (stay_key, kind) index: another sweep got there first. Hand back its row.
        if ((error as { code?: string }).code === "23505") {
          let again = db.from("stay_message_sends").select("*").eq("stay_key", input.stayKey).eq("kind", input.kind);
          if (input.kind === "check_in_correction" && input.factsHash) again = again.eq("facts_hash", input.factsHash);
          const { data: existing, error: readError } = await again.limit(1);
          if (readError || !existing?.[0]) throw error;
          return { row: mapRow(existing[0] as Row), created: false };
        }
        throw error;
      }
      return { row: mapRow(data as Row), created: true };
    },
    async claim(row) {
      const now = new Date();
      const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
      const { data, error } = await db
        .from("stay_message_sends")
        .update({ status: "sending", claim_token: randomUUID(), claimed_at: now.toISOString(), updated_at: now.toISOString() })
        .eq("id", row.id)
        .eq("updated_at", row.updatedAt)
        .or(`status.neq.sending,claimed_at.lt.${stale}`)
        .select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },
    async update(id, patch) {
      const body: Row = { updated_at: new Date().toISOString() };
      if (patch.status !== undefined) {
        body.status = patch.status;
        if (patch.status !== "sending") body.claim_token = null;
      }
      if (patch.holdReason !== undefined) body.hold_reason = patch.holdReason;
      if (patch.sentAt !== undefined) body.sent_at = patch.sentAt;
      if (patch.roomId !== undefined) body.room_id = patch.roomId;
      if (patch.factsHash !== undefined) body.facts_hash = patch.factsHash;
      if (patch.channels !== undefined) body.channels = patch.channels;
      if (patch.threadId !== undefined) body.thread_id = patch.threadId;
      const { error } = await db.from("stay_message_sends").update(body).eq("id", id);
      if (error) throw error;
    },
  };
}

/** A claim older than this belongs to a crashed sweep and may be taken over. */
const CLAIM_STALE_MS = 10 * 60_000;

const keyOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

async function sendSms(db: SupabaseClient, input: StayMessageSendInput) {
  const { candidate, property } = input;
  if (!candidate.guestPhone) return { status: "skipped" as const, reason: "no_phone" };
  if (!candidate.workspaceId) return { status: "failed" as const, reason: "no_workspace" };
  // A PropLane-managed workspace is paid by PropLane (the service owner), never the client owner's wallet: the text leaves on the
  // shared line, idempotent on one claim key so a retry never texts twice. Self-serve workspaces stay on their own line and wallet.
  const payer = await resolveSmsPayer(db, { ownerUserId: candidate.ownerUserId, workspaceId: candidate.workspaceId });
  if (payer !== candidate.ownerUserId.trim()) {
    const viaPropLane = await sendAsPropLaneAfterRefusal(db, {
      ownerUserId: candidate.ownerUserId,
      workspaceId: candidate.workspaceId,
      to: candidate.guestPhone,
      body: input.smsBody,
      claimKey: `stay-msg:${input.dedupeBase}:sms`,
    });
    if (viaPropLane.attempted) return viaPropLane.ok ? { status: "sent" as const } : { status: "failed" as const, reason: viaPropLane.reason ?? "The text was refused." };
  }
  const line = await resolveHouseSmsLine(db, { propertyId: candidate.propertyId, workspaceId: candidate.workspaceId, ownerUserId: candidate.ownerUserId });
  if (!line.ok) return { status: "failed" as const, reason: "No sendable text line for this house." };
  // Twilio has no idempotency key of its own: the outbox row's unique `dedupe_key` is the record, so a re-claim re-reads the
  // SAME outbox row instead of enqueueing a second text.
  const result = await sendFromManagerWorkNumber({
    managerUserId: candidate.ownerUserId,
    workspaceId: candidate.workspaceId,
    to: candidate.guestPhone,
    text: input.smsBody,
    fromNumber: line.fromNumber,
    selectedWorkLineId: line.selectedWorkLineId,
    propertyId: property.propertyId,
    residentUserId: candidate.guestUserId,
    residentEmail: candidate.guestEmail,
    source: "automated",
    sendClass: "transactional",
    counterpartyRole: "resident",
    purpose: "stay_message",
    dedupeKey: `stay-msg:${input.dedupeBase}:sms`,
  });
  return result.ok || result.durablyAccepted ? { status: "sent" as const } : { status: "failed" as const, reason: result.error ?? "The text was refused." };
}

async function sendEmail(db: SupabaseClient, input: StayMessageSendInput) {
  const { candidate } = input;
  if (!candidate.guestEmail) return { status: "skipped" as const, reason: "no_email" };
  const mailbox = await loadManagerAssistantEmail(db, candidate.ownerUserId, candidate.workspaceId);
  if (!mailbox) return { status: "failed" as const, reason: "No work email to send from." };
  const sent = await deliverManagerEmailReply({
    managerUserId: candidate.ownerUserId,
    toEmail: candidate.guestEmail,
    subject: input.subject,
    text: input.body,
    fromAddress: mailbox.address,
    replyTo: mailbox.address,
    idempotencyKey: `stay-msg-${keyOf(input.dedupeBase)}`,
  });
  return sent.ok ? { status: "sent" as const } : { status: "failed" as const, reason: sent.error ?? "The email was refused." };
}

async function ownerIdentity(db: SupabaseClient, ownerUserId: string): Promise<{ email: string; name: string }> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", ownerUserId).maybeSingle();
  const row = (data ?? {}) as Row;
  return { email: str(row.email).toLowerCase(), name: str(row.full_name) || "PropLane" };
}

/** The in-app copy: the guest's own inbox when they have an account, always the manager-side thread with them. */
async function logInApp(db: SupabaseClient, input: StayMessageSendInput, smsSent: boolean) {
  const { candidate } = input;
  const messageId = `stay-msg-${keyOf(input.dedupeBase)}`;
  const owner = await ownerIdentity(db, candidate.ownerUserId);
  if (candidate.guestUserId) {
    const result = await deliverPortalInboxMessage(db, {
      senderUserId: candidate.ownerUserId,
      senderEmail: owner.email,
      fromName: owner.name,
      subject: input.subject,
      text: input.body,
      toUserIds: [candidate.guestUserId],
      recipientsAuthorizedByCaller: true,
      propertyId: candidate.propertyId,
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      deliverViaSms: false,
      automated: true,
      senderRole: "manager",
      messageId,
    } as Parameters<typeof deliverPortalInboxMessage>[1]);
    return result.ok ? { status: "sent" as const } : { status: "failed" as const, reason: result.error ?? "The inbox copy failed." };
  }
  if (candidate.guestEmail) {
    await deliverPortalMessageThreadSide(db, {
      scope: scopeForRole("manager"),
      folder: "inbox",
      ownerUserId: candidate.ownerUserId,
      participantEmail: owner.email || null,
      otherPartyEmail: candidate.guestEmail,
      fallbackId: messageId,
      fromName: "Check-in",
      subject: input.subject,
      body: input.body,
      preview: input.body.replace(/\s+/g, " ").slice(0, 140),
      when: formatInboxStamp(new Date()),
      unread: false,
      outbound: true,
      messageId,
      channel: "email",
      messageSubject: input.subject,
      conversation: { workspaceId: candidate.workspaceId, propertyId: candidate.propertyId, ...(candidate.guestPhone ? { otherPartyPhone: candidate.guestPhone } : {}) },
    });
    return { status: "sent" as const };
  }
  // A phone-only guest has no inbox: the text itself is the Communication thread with them.
  return smsSent ? { status: "sent" as const, reason: "texts_thread" } : { status: "skipped" as const, reason: "no_inbox_contact" };
}

export function createStayMessageSender(db: SupabaseClient) {
  return async (input: StayMessageSendInput): Promise<ChannelResults> => {
    const out: ChannelResults = {};
    const run = async (name: "sms" | "email", fn: () => Promise<{ status: "sent" | "failed" | "skipped"; reason?: string }>) => {
      if (input.already[name]?.status === "sent") return;
      try {
        out[name] = await fn();
      } catch (cause) {
        out[name] = { status: "failed", reason: cause instanceof Error ? cause.message.slice(0, 160) : "send_failed" };
      }
      await input.checkpoint?.({ [name]: out[name] }).catch(() => undefined);
    };
    await run("sms", () => sendSms(db, input));
    await run("email", () => sendEmail(db, input));
    if (input.already.inbox?.status !== "sent") {
      try {
        out.inbox = await logInApp(db, input, (out.sms ?? input.already.sms)?.status === "sent");
      } catch (cause) {
        out.inbox = { status: "failed", reason: cause instanceof Error ? cause.message.slice(0, 160) : "inbox_failed" };
      }
      await input.checkpoint?.({ inbox: out.inbox }).catch(() => undefined);
    }
    return out;
  };
}

/** The held-message flag: an Assistant notice to the owner plus PropLane's staff when the workspace is managed. */
export function createStayManagerFlag(db: SupabaseClient): StayMessageDeps["flagManager"] {
  return async (flag) => {
    try {
      await notifyManagerFromAgent(db, {
        landlordId: flag.ownerUserId,
        subject: "Check-in message held",
        text: flag.text,
        category: "messages",
        notify: { push: true, sms: false },
        idempotencyKey: flag.key,
        propertyId: flag.propertyId,
        workspaceId: flag.workspaceId,
      });
      if (flag.workspaceId) {
        await notifyServiceAlertTargets(db, {
          workspaceId: flag.workspaceId,
          module: "inbox",
          propertyId: flag.propertyId,
          urgent: true,
          smsText: flag.text.slice(0, 300),
          emailSubject: "Check-in message held",
          emailText: flag.text,
          idempotencyKey: flag.key,
        });
      }
    } catch {
      console.error("stay message hold flag failed");
    }
  };
}

export async function runStayMessagesOnDb(db: SupabaseClient, now: Date = new Date()): Promise<StayMessageSweepSummary> {
  const ledger = createStayMessageLedger(db);
  const send = createStayMessageSender(db);
  return runStayMessageSweep({
    now: () => now,
    loadCandidates: () => loadStayCandidates(db, now),
    loadProperty: (id) => loadStayProperty(db, id),
    loadSettings: (scope) => loadStayMessageSettings(db, scope),
    ledger,
    send,
    flagManager: createStayManagerFlag(db),
    recordIssue: async ({ candidate, kind, channel, reason, eventId }) => {
      await recordDeliveryIssue(db, {
        threadId: null,
        workspaceId: candidate.workspaceId,
        direction: "outbound",
        reason: `The ${kind === "check_out" ? "check-out" : "check-in"} message could not be sent by ${channel === "inbox" ? "in-app" : channel}: ${reason}`.slice(0, 240),
        eventId,
      }).catch(() => undefined);
    },
  });
}
