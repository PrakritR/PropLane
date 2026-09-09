import type { SupabaseClient } from "@supabase/supabase-js";
import { smsNoticeIdentity } from "@/lib/sms-inbox-identity";

export type SmsInboxRecord = {
  id: string; owner_user_id?: string | null; scope?: string | null;
  thread_type?: string | null; row_data?: Record<string, unknown> | null;
};
export function storedSmsNoticeIdentity(row: SmsInboxRecord): string | undefined {
  if (row.scope !== "axis_portal_inbox_manager_v1") return;
  return smsNoticeIdentity({ id: row.id, from: String(row.row_data?.from ?? ""),
    ownerUserId: row.owner_user_id ?? undefined, threadType: row.thread_type,
    smsNoticePhone: typeof row.row_data?.smsNoticePhone === "string" ? row.row_data.smsNoticePhone : undefined });
}

/** Caller must first authorize the target record. Ownership comes from that row. */
export async function smsNoticeMembers(db: SupabaseClient, target: SmsInboxRecord): Promise<SmsInboxRecord[]> {
  const identity = storedSmsNoticeIdentity(target);
  if (!identity) return [target];
  const members: SmsInboxRecord[] = [];
  const archived = target.row_data?.folder === "trash";
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from("portal_inbox_thread_records")
      .select("id, owner_user_id, scope, thread_type, row_data")
      .eq("owner_user_id", target.owner_user_id!).eq("scope", target.scope!)
      .order("id").range(offset, offset + 499);
    if (error) throw new Error("Could not resolve SMS conversation members.");
    members.push(...(data ?? []).filter((row) => storedSmsNoticeIdentity(row) === identity
      && (row.row_data?.folder === "trash") === archived));
    if (!data || data.length < 500) return members;
  }
}

/**
 * A synthetic root (`<threadId>-root`, or `merged:` from a prior collapse) is
 * derived at render time from the row's own body, never a stored turn.
 */
const DERIVED_MESSAGE_ID = /(?:^merged:|-root$)/;

type StoredMessage = { id?: unknown };

/**
 * Turns the browser is adding that the server has never stored - a manager's
 * reply is written by the client, so refusing everything it sends would drop it
 * even though the SMS went out.
 *
 * Everything already on any member is excluded, which covers both a re-submit
 * and the sibling turns a collapsed row carries from other member rows. The
 * result is append-only: the browser can contribute a turn it owns, never edit
 * or remove one the server holds.
 */
function unseenClientMessages(
  requested: Record<string, unknown>, members: SmsInboxRecord[],
): StoredMessage[] {
  const known = new Set<string>();
  for (const member of members) {
    const data = member.row_data ?? {};
    if (typeof data.rootMessageId === "string") known.add(data.rootMessageId);
    for (const message of Array.isArray(data.messages) ? data.messages : []) {
      const id = (message as StoredMessage).id;
      if (typeof id === "string") known.add(id);
    }
  }
  const incoming = Array.isArray(requested.messages) ? requested.messages : [];
  return (incoming as StoredMessage[]).filter((message) =>
    typeof message?.id === "string" && message.id
      && !known.has(message.id) && !DERIVED_MESSAGE_ID.test(message.id));
}

/** Browser snapshots may change mailbox state and add their own turns; they may
 * never overwrite or remove the SMS turns the server stored. */
export async function updateSmsNoticeMailboxState(
  db: SupabaseClient, target: SmsInboxRecord, requested: Record<string, unknown>,
): Promise<void> {
  const members = await smsNoticeMembers(db, target);
  // Only the row the browser was actually looking at receives its new turns;
  // adding them to every member would duplicate the reply across the thread.
  const added = unseenClientMessages(requested, members);
  for (const member of members) {
    let done = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, error } = await db.from("portal_inbox_thread_records")
        .select("row_data, updated_at").eq("id", member.id)
        .eq("owner_user_id", target.owner_user_id!).eq("scope", target.scope!).single();
      if (error || !data) throw new Error("Could not load SMS conversation state.");
      const row = data.row_data as Record<string, unknown>;
      const folder = ["inbox", "sent", "trash"].includes(String(requested.folder)) ? requested.folder : row.folder;
      const stored = Array.isArray(row.messages) ? (row.messages as StoredMessage[]) : [];
      const storedIds = new Set(stored.map((message) => message?.id));
      const appending = member.id === target.id
        ? added.filter((message) => !storedIds.has(message.id))
        : [];
      const latest = appending[appending.length - 1] as { at?: unknown } | undefined;
      const next = { ...row, folder,
        unread: typeof requested.unread === "boolean" ? requested.unread : row.unread,
        ...(folder === "trash" && row.folder !== "trash" ? { previousFolder: row.folder } : {}),
        ...(appending.length ? { messages: [...stored, ...appending] } : {}),
        // The AI draft is browser-owned: discarding it is a client action and the
        // row it sends is complete, so an absent key means discarded. Keeping the
        // stored one would resurrect a draft the manager dismissed.
        aiDraft: requested.aiDraft,
        // A reply has to move the conversation up the list like any other turn.
        ...(typeof latest?.at === "string" && latest.at ? { time: latest.at } : {}),
      };
      const { data: changed, error: writeError } = await db.from("portal_inbox_thread_records")
        .update({ row_data: next, updated_at: new Date(Math.max(Date.now(), Date.parse(data.updated_at) + 1)).toISOString() })
        .eq("id", member.id).eq("owner_user_id", target.owner_user_id!).eq("scope", target.scope!)
        .eq("updated_at", data.updated_at).select("id");
      if (writeError) throw new Error("Could not save SMS conversation state.");
      if (changed?.length) { done = true; break; }
    }
    if (!done) throw new Error("SMS conversation changed; retry the mailbox action.");
  }
}
