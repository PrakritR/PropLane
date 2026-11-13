/**
 * Which stored inbox messages are automated noise a one-off cleanup may remove, and which a person typed and must never be
 * touched. Pure: no database, no clock (the caller passes `now`). Used by `scripts/inbox-cleanup.mts`.
 *
 * The rules are deliberately narrow (an allowlist of how automation writes, never "anything not human"):
 *   - Assistant notice: written by `notifyManagerFromAgent` as `agent_notice_msg_<hash>` (or stamped with a `noticeType`),
 *     from "PropLane Assistant", never `outbound: true`. The Assistant's own chat answers (`sms_out_…`, `auto_reply_…`)
 *     and every turn a person typed are kept.
 *   - Team line: posted by PropLane (`from: "PropLane"`, channel `proplane`, id `action-event:…`).
 *   - Lead nudge: the exact "PropLane here. Reply anytime … Reply STOP to opt out." text, on a lead whose ONLY outbound
 *     turns are that nudge.
 */
import { isSystemOnlyOwnerThread, type ManagedOwnerIdentity } from "@/lib/communication/managed-owner-thread";

export type StoredMessage = Record<string, unknown>;
export type ThreadRow = { id: string; thread_type?: string | null; owner_user_id?: string | null; participant_email?: string | null; row_data?: unknown; updated_at?: string | null };

/** Assistant notices younger than this are kept: they are today's news. */
export const NOTICE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function messagesOf(thread: ThreadRow): StoredMessage[] {
  const row = (thread.row_data && typeof thread.row_data === "object" ? thread.row_data : {}) as Record<string, unknown>;
  return Array.isArray(row.messages) ? (row.messages as StoredMessage[]) : [];
}

/** A message's time in ms: an ISO `at`, else the stored label; NaN when unreadable (then it is never treated as old). */
export function messageTimeMs(message: StoredMessage): number {
  const at = str(message.at);
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/** An automated Assistant notice (never a person's turn, never the Assistant's chat answer). */
export function isAutomatedAssistantNotice(message: StoredMessage): boolean {
  if (message.outbound === true) return false;
  if (str(message.from) !== "PropLane Assistant") return false;
  const id = str(message.id);
  if (id.startsWith("sms_out_") || id.startsWith("auto_reply_")) return false;
  return id.startsWith("agent_notice_msg_") || str(message.noticeType) !== "";
}

export type MessagePlan = { keep: StoredMessage[]; remove: StoredMessage[] };

/** (a) The Assistant thread: automated notices older than 24 hours go; everything else stays. */
export function planAssistantNoticeCleanup(thread: ThreadRow, now: Date): MessagePlan {
  const cutoff = now.getTime() - NOTICE_MIN_AGE_MS;
  const keep: StoredMessage[] = [];
  const remove: StoredMessage[] = [];
  for (const message of messagesOf(thread)) {
    const ms = messageTimeMs(message);
    if (isAutomatedAssistantNotice(message) && !Number.isNaN(ms) && ms < cutoff) remove.push(message);
    else keep.push(message);
  }
  return { keep, remove };
}

/** A line PropLane itself posted in the Team chat (`buildTeamNoticeLine` through the action-event bus). */
export function isAutomatedTeamLine(message: StoredMessage): boolean {
  if (message.outbound === false) return false;
  const id = str(message.id);
  return str(message.from) === "PropLane" && (str(message.channel) === "proplane" || id.startsWith("action-event:"));
}

/** (b) The Team chat: PropLane's automated lines go; every human message stays. */
export function planTeamThreadCleanup(thread: ThreadRow): MessagePlan {
  const keep: StoredMessage[] = [];
  const remove: StoredMessage[] = [];
  for (const message of messagesOf(thread)) (isAutomatedTeamLine(message) ? remove : keep).push(message);
  return { keep, remove };
}

/** (c) An in-app thread with a managed workspace's owner that holds only system notices: the whole thread goes. */
export function isDeletableOwnerThread(thread: ThreadRow, owner: ManagedOwnerIdentity): boolean {
  const row = (thread.row_data && typeof thread.row_data === "object" ? thread.row_data : {}) as Record<string, unknown>;
  if (messagesOf(thread).length === 0 && row.rootAutomated !== true) return false;
  return isSystemOnlyOwnerThread(thread, owner);
}

const LEAD_NUDGE = /^\s*PropLane here\.\s*Reply anytime\b[^]*\bReply STOP to opt out\.?\s*$/i;

/** The automated 206-line nudge text. */
export function isLeadNudgeBody(body: unknown): boolean {
  return LEAD_NUDGE.test(String(body ?? ""));
}

export type LeadTurn = { id: string; lead_id: string; direction: string; body: string };

/**
 * (d) A lead's nudge turns, but only for a lead whose outbound turns are ALL that nudge (no human, and no other agent
 * text, ever answered). The lead's own (inbound) turns and every other turn are never returned.
 */
export function planLeadNudgeCleanup(turns: readonly LeadTurn[]): { remove: LeadTurn[]; leads: number } {
  const byLead = new Map<string, LeadTurn[]>();
  for (const turn of turns) {
    const list = byLead.get(turn.lead_id) ?? [];
    list.push(turn);
    byLead.set(turn.lead_id, list);
  }
  const remove: LeadTurn[] = [];
  let leads = 0;
  for (const list of byLead.values()) {
    const outbound = list.filter((t) => t.direction === "outbound");
    if (outbound.length === 0 || !outbound.every((t) => isLeadNudgeBody(t.body))) continue;
    leads += 1;
    remove.push(...outbound);
  }
  return { remove, leads };
}

export const INBOX_CLEANUP_PRODUCTION_REF = "qahnczmilgptcedaqype";
const DEV_REF = "emstjswhotsnyksqhqyf";
const STAGING_REF = "xwszcafaontidfgznlxd";

/**
 * Where a cleanup may WRITE. A dry run only reads, so it is allowed anywhere. `--apply` is allowed on the dev/test project;
 * production, staging and any unknown project need ALLOW_PRODUCTION_INBOX_CLEANUP=1 as well. Throws with the reason.
 */
export function assertInboxCleanupWriteAllowed(ref: string, apply: boolean, env: Record<string, string | undefined> = process.env): void {
  if (!apply) return;
  if (ref === DEV_REF) return;
  if (env.ALLOW_PRODUCTION_INBOX_CLEANUP === "1") return;
  const what = ref === INBOX_CLEANUP_PRODUCTION_REF ? "PRODUCTION" : ref === STAGING_REF ? "STAGING" : `unknown project "${ref}"`;
  throw new Error(`Refusing --apply on ${what}: set ALLOW_PRODUCTION_INBOX_CLEANUP=1 (and pass --apply) to change it.`);
}
