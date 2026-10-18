import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { smsMediaAppUrl } from "@/lib/sms-media.server";

/**
 * Read side of the MMS index: which stored attachments belong to which message.
 * Kept apart from `inbound-media.server.ts` (download + image stack) so the
 * Communication readers import only this small module.
 */

export type SmsMessageMedia = { path: string; contentType: string; url: string };

/** Return `messages` with `media` set on those that carry MMS attachments. */
export async function withSmsMedia<T extends { messageSid: string | null }>(
  db: SupabaseClient,
  messages: T[],
): Promise<Array<T & { media?: SmsMessageMedia[] }>> {
  const bySid = await loadSmsMediaForMessages(db, messages.map((m) => m.messageSid));
  if (bySid.size === 0) return messages;
  return messages.map((m) => {
    const media = m.messageSid ? bySid.get(m.messageSid) : undefined;
    return media?.length ? { ...m, media } : m;
  });
}

/**
 * Media for the MMS messages of a Communication thread, keyed by message SID.
 * Only inbound MMS SIDs ("MM...") are looked up, so a plain-SMS thread costs no
 * query. The `url` is the in-app serve route (a fresh signed URL per view).
 */
export async function loadSmsMediaForMessages(
  db: SupabaseClient,
  messageSids: Array<string | null | undefined>,
): Promise<Map<string, SmsMessageMedia[]>> {
  const out = new Map<string, SmsMessageMedia[]>();
  const sids = [...new Set(messageSids.map((s) => String(s ?? "").trim()).filter((s) => /^MM[0-9a-fA-F]{32}$/.test(s)))];
  if (sids.length === 0) return out;
  try {
    const { data, error } = await db
      .from("sms_media_files")
      .select("message_sid, media_index, storage_path, content_type")
      .in("message_sid", sids.slice(0, 500))
      .order("media_index", { ascending: true });
    if (error || !data) return out;
    for (const row of data) {
      const list = out.get(String(row.message_sid)) ?? [];
      list.push({
        path: String(row.storage_path),
        contentType: String(row.content_type),
        url: smsMediaAppUrl(String(row.storage_path)),
      });
      out.set(String(row.message_sid), list);
    }
  } catch {
    /* no media shown */
  }
  return out;
}
