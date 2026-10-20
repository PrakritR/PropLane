import "server-only";

/**
 * The channel a RESIDENT's lease and charge notices go out on (`notice-channel.ts`): a lease or a charge row
 * carries no channel of its own, so it inherits the one the resident came in on.
 *
 * - a stay charge (`guestStayBlockId`) follows its stay row's recorded source;
 * - anything else follows the resident's newest application row on this workspace that recorded a
 *   `noticeChannel` (a portal-made application is portal, so its lease and charges are answered by email +
 *   the resident portal, never a text);
 * - no recorded channel, no application, or an unreadable read is `sms`: what every such notice did before
 *   the channel was recorded, so a read that fails never changes how someone is reached.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { noticeChannelFor, type NoticeChannel } from "@/lib/notice-channel";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function residentNoticeChannel(
  db: SupabaseClient,
  input: { managerUserId: string; email?: string | null },
): Promise<NoticeChannel> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) return "sms";
  try {
    let query = db
      .from("manager_application_records")
      .select("row_data, updated_at")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false })
      .limit(10);
    if (input.managerUserId) query = query.eq("manager_user_id", input.managerUserId);
    const { data, error } = await query;
    if (error) return "sms";
    for (const record of (data ?? []) as Array<{ row_data: unknown }>) {
      const row = asRecord(record.row_data);
      if (typeof row.noticeChannel === "string") return noticeChannelFor(row);
    }
  } catch {
    /* an unreadable lookup keeps today's behaviour */
  }
  return "sms";
}

/** A charge's channel: its stay's when it is a stay charge, else the resident's. */
export async function chargeNoticeChannel(
  db: SupabaseClient,
  input: { managerUserId: string; charge: { guestStayBlockId?: unknown; residentEmail?: string | null } },
): Promise<NoticeChannel> {
  const blockId = typeof input.charge.guestStayBlockId === "string" ? input.charge.guestStayBlockId.trim() : "";
  if (blockId) {
    try {
      const { data } = await db.from("portal_schedule_records").select("row_data").eq("id", blockId).maybeSingle();
      if (data) return noticeChannelFor(data.row_data);
    } catch {
      /* fall through to the resident's channel */
    }
  }
  return residentNoticeChannel(db, { managerUserId: input.managerUserId, email: input.charge.residentEmail });
}
