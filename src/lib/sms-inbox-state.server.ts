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

/** Browser snapshots may change mailbox state, never overwrite server SMS turns. */
export async function updateSmsNoticeMailboxState(
  db: SupabaseClient, target: SmsInboxRecord, requested: Record<string, unknown>,
): Promise<void> {
  const members = await smsNoticeMembers(db, target);
  for (const member of members) {
    let done = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { data, error } = await db.from("portal_inbox_thread_records")
        .select("row_data, updated_at").eq("id", member.id)
        .eq("owner_user_id", target.owner_user_id!).eq("scope", target.scope!).single();
      if (error || !data) throw new Error("Could not load SMS conversation state.");
      const row = data.row_data as Record<string, unknown>;
      const folder = ["inbox", "sent", "trash"].includes(String(requested.folder)) ? requested.folder : row.folder;
      const next = { ...row, folder,
        unread: typeof requested.unread === "boolean" ? requested.unread : row.unread,
        ...(folder === "trash" && row.folder !== "trash" ? { previousFolder: row.folder } : {}),
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
