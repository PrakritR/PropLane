import "server-only";

import { createHash, createHmac, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { resolveSmsScopeManagerIds } from "@/lib/manager-sms-messages.server";
import { smsInboxOwnerIds } from "@/lib/sms/manager-sms-access.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { buildCommandContext } from "@/lib/manager-sms-commands/context.server";
import { parseRelayShape } from "@/lib/manager-sms-commands/intent";
import type { AgentContext } from "@/lib/tools/context";

/**
 * Reply to a prospect by text (design-1112 section 3.3). An alert text carries a short handle ("K7"). The staff member
 * texts "K7 <answer>" and the answer is sent to THAT prospect, from the thread's own line, logged in the same thread.
 *
 * The handle is the proof of the write: it was sent only to the staff phone that holds it, so no extra 4-digit code
 * (AGENTS.md section 5 item 12). What keeps a 2-character handle safe is the rest of this file: it expires, it is scoped
 * to one staff phone and one workspace, a wrong guess is counted (5 an hour per phone), and it is never guessed between.
 */

export const REPLY_HANDLE_TTL_MS = 12 * 60 * 60 * 1000;
export const REPLY_HANDLE_WRONG_PER_HOUR = 5;
export const REPLY_NUDGE_WINDOW_MS = 30 * 60 * 1000;

const LETTERS = "ABCDEFGHJKMNPQRTUVWXY";
const DIGITS = "23456789";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** E.164 from the stored phone key (10 national digits, or a longer international one). */
function e164FromKey(key: string): string | null {
  const digits = key.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

function randomHandle(length: number): string {
  const letter = () => LETTERS[randomInt(0, LETTERS.length)]!;
  const digit = () => DIGITS[randomInt(0, DIGITS.length)]!;
  // Always carries a digit ("K7", "K2B7"): `parseRelayShape` reads only digit-bearing words as handles.
  return length === 2 ? `${letter()}${digit()}` : `${letter()}${randomInt(0, 2) ? letter() : digit()}${digit()}`;
}

/**
 * The handle an alert text to this staff phone carries, "K7". One live handle per (staff phone, thread): a second alert
 * about the same person repeats it. Null when the store cannot answer (the alert then goes out without a handle).
 */
export async function mintReplyHandleFor(
  db: SupabaseClient,
  input: { staffPhoneE164: string; workspaceId: string; threadId: string; counterpartyPhoneE164: string },
  now: Date = new Date(),
): Promise<string | null> {
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  const counterpartyKey = normalizeConsentPhone(input.counterpartyPhoneE164);
  const threadId = input.threadId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!staffKey || !counterpartyKey || !threadId || !workspaceId) return null;
  const expiresAt = new Date(now.getTime() + REPLY_HANDLE_TTL_MS).toISOString();
  try {
    const { data: live, error: liveError } = await db
      .from("sms_reply_handles")
      .select("id, handle")
      .eq("staff_phone_key", staffKey)
      .eq("thread_id", threadId)
      .eq("workspace_id", workspaceId)
      .gt("expires_at", now.toISOString())
      .limit(1);
    if (liveError) return null;
    const existing = (live as Row[] | null)?.[0];
    if (existing?.handle) {
      await db.from("sms_reply_handles").update({ expires_at: expiresAt }).eq("id", existing.id as string);
      return str(existing.handle);
    }
    // Expired rows of this phone are dead weight and would block their own handle (the pair is unique).
    await db.from("sms_reply_handles").delete().eq("staff_phone_key", staffKey).lt("expires_at", now.toISOString());
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const handle = randomHandle(attempt < 20 ? 2 : 3);
      const { error } = await db.from("sms_reply_handles").insert({
        staff_phone_key: staffKey,
        handle,
        workspace_id: workspaceId,
        thread_id: threadId,
        counterparty_phone_key: counterpartyKey,
        expires_at: expiresAt,
      });
      if (!error) return handle;
      if (error.code !== "23505") return null;
    }
    return null;
  } catch {
    return null;
  }
}

function failureKey(staffKey: string): string {
  const secret = process.env.PHONE_OTP_HMAC_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "reply-handle";
  return `rh:${createHmac("sha256", secret).update(`reply-handle-v1:${staffKey}`).digest("hex")}`;
}

async function wrongHandlesLastHour(db: SupabaseClient, staffKey: string, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("sms_confirmation_failures")
    .select("id")
    .eq("phone_hash", failureKey(staffKey))
    .gte("failed_at", since)
    .limit(REPLY_HANDLE_WRONG_PER_HOUR);
  return error ? null : ((data as unknown[] | null) ?? []).length;
}

async function recordWrongHandle(db: SupabaseClient, staffKey: string, now: Date): Promise<void> {
  await db.from("sms_confirmation_failures").insert({ phone_hash: failureKey(staffKey), failed_at: now.toISOString() }).then(undefined, () => undefined);
}

export type RelayInput = {
  staffPhoneE164: string;
  actorUserId: string;
  workspaceIds: string[];
  body: string;
  messageSid: string;
};

export type RelayDeps = {
  buildContext: (db: SupabaseClient, input: { actorUserId: string; workspaceId: string }) => Promise<AgentContext | null>;
  /** The inbox send core: same consent, line, payer and outbox gates as Communication. */
  send: (db: SupabaseClient, args: Parameters<typeof sendManagerConversationSms>[1]) => Promise<{ body: Record<string, unknown>; status: number }>;
  /** Logs the staff member's words into the thread (the prospect spine). Best effort. */
  recordOutbound: (db: SupabaseClient, input: { workspaceId: string; ownerUserId: string; threadId: string; body: string; staffUserId: string; staffName: string; eventId: string }) => Promise<void>;
  editOwnerIds: (ctx: AgentContext) => Promise<string[]>;
  now: () => Date;
  /**
   * A relay on a PropLane-MANAGED workspace must not die on the client's wallet: when the normal send is refused,
   * PropLane sends it itself (`sendAsPropLaneAfterRefusal`, the inbox route's rule). Self-serve stays fail-closed.
   */
  propLaneFallback?: (db: SupabaseClient, input: { ownerUserId: string; workspaceId: string; to: string; body: string; claimKey: string; refusalCode: string | null }) => Promise<{ attempted: boolean; ok: boolean }>;
};

async function defaultRecordOutbound(db: SupabaseClient, input: Parameters<RelayDeps["recordOutbound"]>[1]): Promise<void> {
  const spine = await import("@/lib/prospect-spine/index.server");
  await spine.recordOutbound(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    threadId: input.threadId,
    body: input.body,
    channel: "sms",
    author: { kind: "staff", userId: input.staffUserId, name: input.staffName },
    eventId: input.eventId,
  });
}

export const defaultRelayDeps: RelayDeps = {
  buildContext: buildCommandContext,
  send: sendManagerConversationSms,
  recordOutbound: defaultRecordOutbound,
  editOwnerIds: (ctx) => (ctx.managerSmsAccess ? smsInboxOwnerIds(ctx, "edit") : resolveSmsScopeManagerIds(ctx.db, ctx.userId, "edit")),
  now: () => new Date(),
  propLaneFallback: async (db, input) => {
    const { sendAsPropLaneAfterRefusal } = await import("@/lib/prospect-spine/payer.server");
    return sendAsPropLaneAfterRefusal(db, input);
  },
};

type Reply = { handled: false } | { handled: true; reply: string };

async function counterpartyLabel(db: SupabaseClient, row: Row, workspaceId: string): Promise<string> {
  let name = "";
  let context = "";
  try {
    const { data } = await db.from("sms_phone_contacts").select("display_name").eq("phone_key", str(row.counterparty_phone_key)).limit(1);
    name = str((data as Row[] | null)?.[0]?.display_name);
  } catch {
    /* label only */
  }
  try {
    const { data } = await db.from("portal_inbox_thread_records").select("row_data").eq("id", str(row.thread_id)).eq("workspace_id", workspaceId).limit(1);
    const rd = ((data as Row[] | null)?.[0]?.row_data ?? {}) as Record<string, unknown>;
    const ctxRow = (rd.prospectContext ?? null) as Record<string, unknown> | null;
    const property = str(ctxRow?.propertyLabel).split(",")[0] ?? "";
    const room = str(ctxRow?.roomLabel);
    context = [property, room].filter(Boolean).join(" · ");
    if (!name) name = str(rd.counterpartyName) || str(rd.contactName);
  } catch {
    /* label only */
  }
  const who = name || "the prospect";
  return context ? `${who} (${context})` : who;
}

const IMPERATIVE = /^(?:mark|send|remind|show|list|create|cancel|approve|schedule|add|remove|delete|set|change|update|text|email|call|tell|check|find|get|give|run|open|pay|charge|invoice|assign|dispatch|book|move|reschedule|decline|deny|archive|new|start|stop|help)\b/i;

/**
 * "K7 <answer>" -> sent to that prospect. `handled: false` = not a relay at all (the text is something else).
 * A handle-shaped first word that is not live never guesses: expired says so, unknown counts toward the hourly cap.
 */
export async function relayReply(db: SupabaseClient, input: RelayInput, deps: RelayDeps = defaultRelayDeps): Promise<Reply> {
  const now = deps.now();
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  if (!staffKey) return { handled: false };
  const shape = parseRelayShape(input.body);
  if (!shape) return { handled: false };

  const wrong = await wrongHandlesLastHour(db, staffKey, now);
  if (wrong === null) return { handled: false };
  if (wrong >= REPLY_HANDLE_WRONG_PER_HOUR) {
    return { handled: true, reply: "Too many handles that did not match, so replying by text is paused for now. Reply from PropLane instead." };
  }

  const { data, error } = await db
    .from("sms_reply_handles")
    .select("id, handle, workspace_id, thread_id, counterparty_phone_key, expires_at, created_at")
    .eq("staff_phone_key", staffKey)
    .eq("handle", shape.handle)
    .limit(1);
  if (error) return { handled: false };
  const row = (data as Row[] | null)?.[0];
  if (!row) {
    await recordWrongHandle(db, staffKey, now);
    return { handled: false };
  }
  if (new Date(str(row.expires_at)).getTime() <= now.getTime()) {
    return { handled: true, reply: `The handle ${shape.handle} has expired. Reply from PropLane, or wait for their next text.` };
  }
  const workspaceId = str(row.workspace_id);
  // Scoped to the workspaces this verified phone may run: a handle from another workspace is a wrong handle.
  if (!input.workspaceIds.includes(workspaceId)) {
    await recordWrongHandle(db, staffKey, now);
    return { handled: false };
  }
  const phone = e164FromKey(str(row.counterparty_phone_key));
  const ctx = phone ? await deps.buildContext(db, { actorUserId: input.actorUserId, workspaceId }) : null;
  if (!phone || !ctx) return { handled: true, reply: "I could not send that from here. Reply from PropLane instead." };

  const label = await counterpartyLabel(db, row, workspaceId);
  const ids = await deps.editOwnerIds(ctx).catch(() => [] as string[]);
  const sent = await deps.send(db, {
    actorUserId: ctx.userId,
    // The staff member's own words, not an assistant draft: the bubble keeps their name.
    author: "manager",
    scopeManagerIds: ids,
    toPhone: phone,
    text: shape.message,
    idempotencyKey: `relay_${createHash("sha256").update(`${input.messageSid}:${shape.handle}`).digest("hex").slice(0, 40)}`,
    workspace: { id: workspaceId },
  });
  if (sent.status !== 200 && sent.status !== 202) {
    const reason = typeof sent.body.error === "string" ? sent.body.error : "It could not be sent.";
    const fallback = deps.propLaneFallback
      ? await deps
          .propLaneFallback(db, {
            ownerUserId: ctx.landlordId,
            workspaceId,
            to: phone,
            body: shape.message,
            claimKey: `relay:${input.messageSid}:${shape.handle}`,
            refusalCode: typeof sent.body.code === "string" ? sent.body.code : null,
          })
          .catch(() => ({ attempted: false, ok: false }))
      : { attempted: false, ok: false };
    if (!fallback.ok) return { handled: true, reply: `Not sent to ${label}. ${reason}`.slice(0, 300) };
  }
  await deps
    .recordOutbound(db, {
      workspaceId,
      ownerUserId: ctx.landlordId,
      threadId: str(row.thread_id),
      body: shape.message,
      staffUserId: ctx.userId,
      staffName: ctx.email || "PropLane",
      eventId: `relay:${input.messageSid}`,
    })
    .catch(() => undefined);
  return { handled: true, reply: `Sent to ${label}.` };
}

/**
 * Exactly one fresh alert and a short answer-shaped text with no handle: ask, never send. Called LAST, after every
 * other command has declined the text, so it can never swallow an instruction meant for the manager agent.
 */
export async function nudgeReply(db: SupabaseClient, input: { staffPhoneE164: string; body: string }, now: Date = new Date()): Promise<Reply> {
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  if (!staffKey) return { handled: false };
  const body = input.body.trim();
  if (!body || body.length > 80 || body.endsWith("?") || IMPERATIVE.test(body)) return { handled: false };
  const since = new Date(now.getTime() - REPLY_NUDGE_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("sms_reply_handles")
    .select("handle, workspace_id, thread_id, counterparty_phone_key, created_at")
    .eq("staff_phone_key", staffKey)
    .gte("created_at", since)
    .gt("expires_at", now.toISOString())
    .limit(3);
  if (error) return { handled: false };
  const rows = (data as Row[] | null) ?? [];
  if (rows.length !== 1) return { handled: false };
  const row = rows[0]!;
  const label = await counterpartyLabel(db, row, str(row.workspace_id));
  return { handled: true, reply: `Reply to ${label}? Send: ${str(row.handle)} <message>` };
}
