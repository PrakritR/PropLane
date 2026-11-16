import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runLeasingWebAgentTurn } from "@/lib/agent/leasing-web-agent.server";
import { partyFacingAnswerHold } from "@/lib/automation-send-mode.server";
import { loadMessageListing, type MessageListing } from "@/lib/listing-message/listing.server";
import { finishEmailAutoReplyCredit, reserveEmailAutoReplyCredit } from "@/lib/manager-assistant-email/email-auto-reply-credit.server";
import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { otpMessageBody, requestPhoneOtp, verifyPhoneOtp } from "@/lib/one-number/phone-otp.server";
import { publicBindPhoneKey } from "@/lib/one-number/public-bind.server";
import { normalizeE164 } from "@/lib/phone-e164";
import type { RecordInboundInput, RecordInboundResult, RecordOutboundInput, StitchResult } from "@/lib/prospect-spine/contracts";
import { recordInboundWithExtras, recordOutbound, upsertPhoneContact } from "@/lib/prospect-spine/record.server";
import { stitchByPhone } from "@/lib/prospect-spine/stitch.server";
import { readThread } from "@/lib/prospect-spine/thread.server";
import { rateLimit } from "@/lib/rate-limit";
import { SMS_AUTO_REPLY_AUTHOR } from "@/lib/sms-auto-reply";
import { recordOptIn } from "@/lib/sms-consent";
import { phoneRateKey } from "@/lib/sms/phone-key";
import { phoneClaimedInText, visibleTurnsOf, type VisibleTurn } from "@/lib/web-chat/model";
import { visitorHandle } from "@/lib/web-chat/visitor-session";
import { isAssistantPaused } from "@/lib/assistant-review/store.server";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Caps. A turn costs the home's workspace a paid assistant turn, so these are tight and every one is per workspace-safe key. */
export const WEB_CHAT_LIMITS = {
  sendPerIpPerHour: 40,
  sendPerVisitorPerHour: 20,
  sendPerVisitorPerDay: 80,
  sendPerPropertyPerHour: 300,
  pollPerVisitorPerHour: 360,
  codePerIpPerHour: 8,
  codePerPhonePerHour: 4,
  verifyPerIpPerHour: 30,
  verifyPerPhonePerHour: 15,
} as const;

export type SessionRow = {
  id: string;
  visitorId: string;
  workspaceId: string;
  propertyId: string | null;
  roomId: string | null;
  threadId: string | null;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
};

export type WebChatOutcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 404 | 429 | 502 | 503; error: string; needsNewCode?: true };

/** Everything the orchestration touches, as ports, so the tests drive it with the spine and the model mocked. */
export interface WebChatDeps {
  now(): Date;
  uuid(): string;
  loadListing(propertyId: string, roomId: string | null): Promise<{ ok: true; listing: MessageListing } | { ok: false; reason: "not_found" | "room_not_found" }>;
  rateLimit(key: string, limit: number, windowMs: number): Promise<boolean>;
  sessions: {
    get(visitorId: string, workspaceId: string): Promise<SessionRow | null>;
    getForProperty(visitorId: string, propertyId: string): Promise<SessionRow | null>;
    upsert(input: { visitorId: string; workspaceId: string; propertyId: string; roomId: string | null }): Promise<SessionRow | null>;
    patch(id: string, patch: Partial<{ threadId: string; phoneE164: string; phoneVerifiedAt: string; bump: boolean }>): Promise<void>;
  };
  recordInbound(input: RecordInboundInput): Promise<RecordInboundResult>;
  recordOutbound(input: RecordOutboundInput): Promise<{ ok: boolean }>;
  readThreadRow(threadId: string): Promise<{ ownerUserId: string; rowData: Record<string, unknown> } | null>;
  agent: {
    reserve(input: { ownerUserId: string; workspaceId: string; eventId: string }): Promise<{ allowed: true; key: string } | { allowed: false; reason: string }>;
    finish(input: { ownerUserId: string; key: string; produced: boolean }): Promise<void>;
    approvalHold(ownerUserId: string): Promise<boolean>;
    /** A manager paused the assistant on this conversation (Assistant review). Unreadable reads as paused. */
    paused?(input: { workspaceId: string; threadKeys: string[] }): Promise<boolean>;
    run(input: { listing: MessageListing; visitorId: string; text: string; eventId: string }): Promise<{ reply: string } | null>;
  };
  phone: {
    sendCode(input: { listing: MessageListing; phoneKey: string; subjectId: string }): Promise<{ ok: true } | { ok: false; reason: "rate_limited" | "unavailable" | "failed" }>;
    verifyCode(input: { phoneKey: string; subjectId: string; code: string; now: Date }): Promise<{ ok: true } | { ok: false; reason: "locked" | "wrong" }>;
    markVerified(input: { phoneE164: string }): Promise<void>;
    stitch(input: { workspaceId: string; visitorId: string; phoneE164: string }): Promise<StitchResult | null>;
  };
}

const eventIdFor = (visitorId: string, clientMessageId: string) =>
  `web:${createHash("sha256").update(`${visitorId}:${clientMessageId}`).digest("hex").slice(0, 32)}`;

export type SendResult = {
  messageId: string;
  /** The assistant's reply, when one was produced; absent when the team will answer (held, no credit, a failed turn). */
  reply?: string;
  /** A phone the visitor typed: the widget offers the texted code. A claim, never a merge. */
  phoneOffer?: string;
  duplicate?: boolean;
};

export async function sendWebChatMessage(
  deps: WebChatDeps,
  input: { visitorId: string; ip: string; propertyId: string; roomId: string | null; body: string; clientMessageId: string },
): Promise<WebChatOutcome<SendResult>> {
  const L = WEB_CHAT_LIMITS;
  const tooMany = { ok: false as const, status: 429 as const, error: "Too many messages. Try again later." };
  if (!(await deps.rateLimit(`web-chat-send-ip:${input.ip}`, L.sendPerIpPerHour, HOUR_MS))) return tooMany;
  if (!(await deps.rateLimit(`web-chat-send-visitor-h:${input.visitorId}`, L.sendPerVisitorPerHour, HOUR_MS))) return tooMany;
  if (!(await deps.rateLimit(`web-chat-send-visitor-d:${input.visitorId}`, L.sendPerVisitorPerDay, DAY_MS))) return tooMany;

  // The home, its workspace and its owner are re-derived from the database; the body names only ids.
  const found = await deps.loadListing(input.propertyId, input.roomId);
  if (!found.ok) return { ok: false, status: found.reason === "room_not_found" ? 400 : 404, error: found.reason === "room_not_found" ? "That room is not on this listing." : "This listing is not available." };
  const { listing } = found;
  if (!(await deps.rateLimit(`web-chat-send-property:${listing.propertyId}`, L.sendPerPropertyPerHour, HOUR_MS))) return tooMany;

  const session = await deps.sessions.upsert({ visitorId: input.visitorId, workspaceId: listing.workspaceId, propertyId: listing.propertyId, roomId: listing.roomId });
  if (!session) return { ok: false, status: 503, error: "We could not send that just now. Try again." };

  const eventId = eventIdFor(input.visitorId, input.clientMessageId);
  const provenPhone = session.phoneVerifiedAt && session.phoneE164 ? session.phoneE164 : null;
  // A PROVEN phone writes into that phone's thread (the one the (206) line already uses); before proof the visitor is a handle.
  const recorded = await deps.recordInbound({
    workspaceId: listing.workspaceId,
    ownerUserId: listing.ownerUserId,
    identity: provenPhone
      ? { kind: "phone", phoneE164: provenPhone, verified: true }
      : { kind: "handle", contactHandle: visitorHandle(input.visitorId), site: "web_chat", displayName: "Web visitor" },
    context: { propertyId: listing.propertyId, roomId: listing.roomId, roomLabel: listing.roomLabel, source: "web_chat" },
    body: input.body,
    channel: "in_app",
    eventId,
    occurredAt: deps.now().toISOString(),
  });
  if (!recorded.ok) return { ok: false, status: 503, error: "We could not send that just now. Try again." };
  if (recorded.duplicate) return { ok: true, messageId: recorded.messageId, duplicate: true };
  if (recorded.threadId !== session.threadId) await deps.sessions.patch(session.id, { threadId: recorded.threadId, bump: true });
  else await deps.sessions.patch(session.id, { bump: true });

  const claimed = provenPhone ? null : phoneClaimedInText(input.body);
  const base: SendResult = { messageId: recorded.messageId, ...(claimed ? { phoneOffer: claimed } : {}) };

  // The assistant, exactly as for a text: credit reserved BEFORE any model work, handed back when nothing was produced; the
  // manager's approval setting holds the reply (the team sees the message and answers).
  const credit = await deps.agent.reserve({ ownerUserId: listing.ownerUserId, workspaceId: listing.workspaceId, eventId });
  if (!credit.allowed) return { ok: true, ...base };
  let reply = "";
  try {
    const held =
      (await deps.agent.approvalHold(listing.ownerUserId).catch(() => true)) ||
      (deps.agent.paused
        ? await deps.agent
            .paused({ workspaceId: listing.workspaceId, threadKeys: [recorded.threadId, `web:${session.id}`] })
            .catch(() => true)
        : false);
    if (!held) {
      const turn = await deps.agent.run({ listing, visitorId: input.visitorId, text: input.body, eventId });
      reply = turn?.reply?.trim() ?? "";
    }
  } catch {
    reply = "";
  }
  await deps.agent.finish({ ownerUserId: listing.ownerUserId, key: credit.key, produced: Boolean(reply) });
  if (!reply) return { ok: true, ...base };

  await deps.recordOutbound({
    workspaceId: listing.workspaceId,
    ownerUserId: listing.ownerUserId,
    threadId: recorded.threadId,
    body: reply,
    channel: "in_app",
    author: { kind: "assistant" },
    eventId: `${eventId}:reply`,
    context: { propertyId: listing.propertyId, roomId: listing.roomId, roomLabel: listing.roomLabel, source: "web_chat" },
  }).catch(() => ({ ok: false }));
  return { ok: true, ...base, reply };
}

/** Step 1 of continuing by text: a code to the typed number. Blind to whether the number is known. */
export async function sendWebChatPhoneCode(
  deps: WebChatDeps,
  input: { visitorId: string; ip: string; propertyId: string; phone: string },
): Promise<WebChatOutcome> {
  const L = WEB_CHAT_LIMITS;
  const phoneKey = publicBindPhoneKey(input.phone);
  if (!phoneKey) return { ok: false, status: 400, error: "Enter a US phone number." };
  if (!(await deps.rateLimit(`web-chat-code-ip:${input.ip}`, L.codePerIpPerHour, HOUR_MS))) return { ok: false, status: 429, error: "Too many tries. Try again later." };
  if (!(await deps.rateLimit(`web-chat-code-phone:${phoneRateKey(phoneKey)}`, L.codePerPhonePerHour, HOUR_MS))) return { ok: false, status: 429, error: "Too many tries. Try again later." };
  const found = await deps.loadListing(input.propertyId, null);
  if (!found.ok) return { ok: false, status: 404, error: "This listing is not available." };
  // The code is bound to THIS visitor's session: another visitor cannot spend it.
  const sent = await deps.phone.sendCode({ listing: found.listing, phoneKey, subjectId: `web_chat:${input.visitorId}` });
  if (sent.ok) return { ok: true };
  if (sent.reason === "rate_limited") return { ok: false, status: 429, error: "Too many codes were sent to this number. Try again in an hour." };
  return { ok: false, status: sent.reason === "unavailable" ? 503 : 502, error: "We could not text that number. Check it and try again." };
}

/**
 * Step 2: check the code. ONLY a proven phone merges: the visitor's handle thread is stitched into the phone's thread
 * (`stitchByPhone`, the spine's own merge) and every later message of this visitor writes into it, so a text from that
 * phone to the (206) line continues the same conversation. A typed-but-unproven number never reaches this function.
 */
export async function verifyWebChatPhone(
  deps: WebChatDeps,
  input: { visitorId: string; ip: string; propertyId: string; phone: string; otp: string },
): Promise<WebChatOutcome<{ merged: boolean }>> {
  const L = WEB_CHAT_LIMITS;
  const phoneKey = publicBindPhoneKey(input.phone);
  const phoneE164 = phoneKey ? normalizeE164(phoneKey) : null;
  if (!phoneKey || !phoneE164) return { ok: false, status: 400, error: "Enter a US phone number." };
  if (!(await deps.rateLimit(`web-chat-verify-ip:${input.ip}`, L.verifyPerIpPerHour, HOUR_MS))) return { ok: false, status: 429, error: "Too many tries. Try again later." };
  if (!(await deps.rateLimit(`web-chat-verify-phone:${phoneRateKey(phoneKey)}`, L.verifyPerPhonePerHour, HOUR_MS))) return { ok: false, status: 429, error: "Too many tries. Try again later." };
  const found = await deps.loadListing(input.propertyId, null);
  if (!found.ok) return { ok: false, status: 404, error: "This listing is not available." };
  const { listing } = found;
  const session = await deps.sessions.get(input.visitorId, listing.workspaceId);
  if (!session) return { ok: false, status: 400, error: "Send a message first." };

  const verified = await deps.phone.verifyCode({ phoneKey, subjectId: `web_chat:${input.visitorId}`, code: input.otp, now: deps.now() });
  if (!verified.ok) {
    if (verified.reason === "locked") return { ok: false, status: 429, error: "Too many wrong codes. Ask for a new code." };
    return { ok: false, status: 400, error: "That code did not work." };
  }
  const at = deps.now().toISOString();
  await deps.phone.markVerified({ phoneE164 });
  const stitched = await deps.phone.stitch({ workspaceId: listing.workspaceId, visitorId: input.visitorId, phoneE164 });
  await deps.sessions.patch(session.id, { phoneE164, phoneVerifiedAt: at, ...(stitched && stitched.ok ? { threadId: stitched.threadId } : {}) });
  return { ok: true, merged: Boolean(stitched && stitched.ok) };
}

export type PollResult = { turns: VisibleTurn[]; verified: boolean };

/**
 * The visitor's own turns, oldest first, after a cursor. Before a phone is proven the only thread a visitor can read is the
 * handle thread THEIR cookie created; the thread is looked up by the session row, never by anything in the request.
 */
export async function pollWebChat(
  deps: WebChatDeps,
  input: { visitorId: string; propertyId: string; afterId: string | null },
): Promise<WebChatOutcome<PollResult>> {
  if (!(await deps.rateLimit(`web-chat-poll-visitor:${input.visitorId}`, WEB_CHAT_LIMITS.pollPerVisitorPerHour, HOUR_MS))) {
    return { ok: false, status: 429, error: "Too many tries. Try again later." };
  }
  const session = await deps.sessions.getForProperty(input.visitorId, input.propertyId);
  if (!session || !session.threadId) return { ok: true, turns: [], verified: false };
  const thread = await deps.readThreadRow(session.threadId);
  if (!thread) return { ok: true, turns: [], verified: Boolean(session.phoneVerifiedAt) };
  const all = visibleTurnsOf(thread.rowData, SMS_AUTO_REPLY_AUTHOR);
  const index = input.afterId ? all.findIndex((t) => t.id === input.afterId) : -1;
  return { ok: true, turns: index >= 0 ? all.slice(index + 1) : all, verified: Boolean(session.phoneVerifiedAt) };
}

// ---------------------------------------------------------------------------------------------
// The real ports
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

function toSession(row: Row | null): SessionRow | null {
  if (!row) return null;
  return {
    id: str(row.id), visitorId: str(row.visitor_id), workspaceId: str(row.workspace_id),
    propertyId: str(row.property_id) || null, roomId: str(row.room_id) || null, threadId: str(row.thread_id) || null,
    phoneE164: str(row.phone_e164) || null, phoneVerifiedAt: str(row.phone_verified_at) || null,
  };
}

const SESSION_COLUMNS = "id, visitor_id, workspace_id, property_id, room_id, thread_id, phone_e164, phone_verified_at";

export function createWebChatDeps(db: SupabaseClient): WebChatDeps {
  return {
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    loadListing: (propertyId, roomId) => loadMessageListing(db, { propertyId, roomId }),
    rateLimit: async (key, limit, windowMs) => (await rateLimit(key, limit, windowMs)).ok,
    sessions: {
      async get(visitorId, workspaceId) {
        const { data } = await db.from("web_chat_sessions").select(SESSION_COLUMNS).eq("visitor_id", visitorId).eq("workspace_id", workspaceId).maybeSingle();
        return toSession(data as Row | null);
      },
      async getForProperty(visitorId, propertyId) {
        const { data } = await db.from("web_chat_sessions").select(SESSION_COLUMNS).eq("visitor_id", visitorId).eq("property_id", propertyId).order("last_seen_at", { ascending: false }).limit(1).maybeSingle();
        return toSession(data as Row | null);
      },
      async upsert(input) {
        const read = async () => {
          const { data } = await db.from("web_chat_sessions").select(SESSION_COLUMNS).eq("visitor_id", input.visitorId).eq("workspace_id", input.workspaceId).maybeSingle();
          return toSession(data as Row | null);
        };
        const existing = await read();
        if (existing) {
          await db.from("web_chat_sessions").update({ property_id: input.propertyId, room_id: input.roomId, last_seen_at: new Date().toISOString() }).eq("id", existing.id);
          return { ...existing, propertyId: input.propertyId, roomId: input.roomId };
        }
        const { error } = await db.from("web_chat_sessions").insert({
          visitor_id: input.visitorId, workspace_id: input.workspaceId, property_id: input.propertyId, room_id: input.roomId,
        });
        if (error && error.code !== "23505") return null;
        return read();
      },
      async patch(id, patch) {
        const update: Row = { last_seen_at: new Date().toISOString() };
        if (patch.threadId) update.thread_id = patch.threadId;
        if (patch.phoneE164) update.phone_e164 = patch.phoneE164;
        if (patch.phoneVerifiedAt) update.phone_verified_at = patch.phoneVerifiedAt;
        if (patch.bump) {
          const { data } = await db.from("web_chat_sessions").select("message_count").eq("id", id).maybeSingle();
          update.message_count = Number((data as Row | null)?.message_count ?? 0) + 1;
        }
        await db.from("web_chat_sessions").update(update).eq("id", id);
      },
    },
    recordInbound: (input) => recordInboundWithExtras(db, input, { subjectLabel: "Web chat" }),
    recordOutbound: (input) => recordOutbound(db, input),
    readThreadRow: async (threadId) => {
      const thread = await readThread(db, threadId);
      return thread ? { ownerUserId: thread.ownerUserId, rowData: thread.rowData } : null;
    },
    agent: {
      reserve: (input) => reserveEmailAutoReplyCredit(db, { managerUserId: input.ownerUserId, workspaceId: input.workspaceId, inboundEmailId: input.eventId, role: "prospect", channel: "inapp" }),
      finish: (input) => finishEmailAutoReplyCredit(db, { managerUserId: input.ownerUserId, key: input.key, replyProduced: input.produced }),
      approvalHold: async (ownerUserId) => (await partyFacingAnswerHold(db, ownerUserId)).hold,
      paused: (input) => isAssistantPaused(db, { workspaceId: input.workspaceId, threadKeys: input.threadKeys }),
      run: (input) => runLeasingWebAgentTurn(db, {
        landlordId: input.listing.ownerUserId,
        visitorId: input.visitorId,
        inboundText: input.text,
        sourceMessageId: input.eventId,
        listing: { propertyId: input.listing.propertyId, label: input.listing.propertyLabel, roomLabel: input.listing.roomLabel },
      }),
    },
    phone: {
      async sendCode({ listing, phoneKey, subjectId }) {
        const sent = await requestPhoneOtp(db, {
          phoneKey, purpose: "listing_message", subjectId,
          send: (code, challengeId) => sendWorkspacePhoneText(db, {
            workspaceId: listing.workspaceId, phoneKey, body: otpMessageBody(code), role: roleForLinkPurpose("public_tour"),
            idempotencyKey: `phone-code:${challengeId}`, basis: { kind: "code" },
          }),
        });
        if (sent.ok) return { ok: true };
        return { ok: false, reason: sent.reason === "rate_limited" ? "rate_limited" : sent.reason === "unavailable" ? "unavailable" : "failed" };
      },
      async verifyCode({ phoneKey, subjectId, code, now }) {
        const verified = await verifyPhoneOtp(db, { phoneKey, purpose: "listing_message", subjectId, code, now });
        if (verified.ok) return { ok: true };
        return { ok: false, reason: verified.reason === "locked" ? "locked" : "wrong" };
      },
      async markVerified({ phoneE164 }) {
        await recordOptIn(db, phoneE164, null, "web-chat").catch(() => undefined);
        await upsertPhoneContact(db, { phoneE164, verified: true, source: "web_chat" }).catch(() => undefined);
      },
      async stitch({ workspaceId, visitorId, phoneE164 }) {
        const { data } = await db.from("prospect_contexts").select("id").eq("workspace_id", workspaceId).eq("contact_handle", visitorHandle(visitorId)).limit(1).maybeSingle();
        const contextId = str((data as Row | null)?.id);
        return contextId ? stitchByPhone(db, { contextId, phoneE164 }) : null;
      },
    },
  };
}
