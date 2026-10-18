import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTwilioMessageMedia } from "@/lib/inspections/attachment-intake.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import {
  SMS_MEDIA_BUCKET,
  SMS_MEDIA_MAX_BYTES,
  smsMediaAppUrl,
  storeInboundMediaBytes,
} from "@/lib/sms-media.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";

/**
 * Inbound MMS for every role. Each media item on an inbound text is downloaded
 * right away (Twilio deletes it, and its URL needs the account credentials)
 * into the PRIVATE `sms-media` bucket and indexed in `sms_media_files`. Nothing
 * here is ever public: a file is viewed only through `/api/sms-media`, which
 * mints a short-lived signed URL after an ownership check.
 */

export type SmsMediaLinkedType =
  | "work_order"
  | "service_request"
  | "inspection"
  | "move_in"
  | "move_out"
  | "listing"
  | "vendor_job"
  | "lead";

export type SmsMediaFileRow = {
  id: string;
  message_sid: string;
  media_index: number;
  workspace_id: string | null;
  sender_phone_key: string;
  storage_path: string;
  content_type: string;
  byte_size: number | null;
  linked_type: SmsMediaLinkedType | null;
  linked_id: string | null;
  created_at: string;
};

const FILE_COLUMNS =
  "id, message_sid, media_index, workspace_id, sender_phone_key, storage_path, content_type, byte_size, linked_type, linked_id, created_at";

/** Twilio's per-message cap is 10; the table allows indexes 0-9. */
const MAX_MEDIA_PER_MESSAGE = 10;

export type InboundMediaItem = { index: number; url: string; declaredType: string };

/** The media items the verified webhook listed (NumMedia / MediaUrlN / MediaContentTypeN). */
export function inboundMediaItems(params: Record<string, string>): InboundMediaItem[] {
  const count = Math.min(Number(params.NumMedia ?? 0) || 0, MAX_MEDIA_PER_MESSAGE);
  const items: InboundMediaItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const url = String(params[`MediaUrl${index}`] ?? "").trim();
    if (!url.startsWith("https://")) continue;
    items.push({ index, url, declaredType: String(params[`MediaContentType${index}`] ?? "").trim().toLowerCase() });
  }
  return items;
}

export type IngestedMedia = {
  index: number;
  path: string;
  contentType: string;
  byteSize: number;
};

/**
 * Download + store + index every media item of one inbound text. Idempotent on
 * (message_sid, media_index): a webhook retry never stores or indexes twice.
 * Best-effort per item: a refused or failed item is skipped, never fatal.
 */
export async function ingestInboundMedia(
  db: SupabaseClient,
  args: {
    messageSid: string;
    ownerUserId: string;
    workspaceId: string | null;
    senderPhone: string;
    params: Record<string, string>;
  },
): Promise<IngestedMedia[]> {
  const items = inboundMediaItems(args.params);
  if (items.length === 0) return [];
  const phoneKey = normalizeConsentPhone(args.senderPhone);
  if (!phoneKey) return [];

  const existing = new Map<number, IngestedMedia>();
  try {
    const { data, error } = await db
      .from("sms_media_files")
      .select("media_index, storage_path, content_type, byte_size")
      .eq("message_sid", args.messageSid);
    if (!error) {
      for (const row of data ?? []) {
        existing.set(Number(row.media_index), {
          index: Number(row.media_index),
          path: String(row.storage_path),
          contentType: String(row.content_type),
          byteSize: Number(row.byte_size ?? 0),
        });
      }
    }
  } catch {
    /* index unreadable: store anyway; the upload path is deterministic */
  }

  const out: IngestedMedia[] = [];
  for (const item of items) {
    const already = existing.get(item.index);
    if (already) {
      out.push(already);
      continue;
    }
    try {
      const fetched = await fetchTwilioMessageMedia(item.url, args.messageSid, SMS_MEDIA_MAX_BYTES);
      const stored = await storeInboundMediaBytes(db, {
        managerUserId: args.ownerUserId,
        messageSid: args.messageSid,
        index: item.index,
        bytes: fetched.bytes,
        mime: fetched.contentType || item.declaredType,
      });
      if (!stored) continue;
      const { error } = await db.from("sms_media_files").upsert(
        {
          message_sid: args.messageSid,
          media_index: item.index,
          ...(args.workspaceId ? { workspace_id: args.workspaceId } : {}),
          sender_phone_key: phoneKey,
          storage_path: stored.path,
          content_type: stored.contentType,
          byte_size: stored.byteSize,
        },
        { onConflict: "message_sid,media_index", ignoreDuplicates: true },
      );
      // A missing table (code runs before its migration) leaves the file stored but unindexed.
      if (error && !isMissingSchemaError(error)) continue;
      out.push({ index: item.index, path: stored.path, contentType: stored.contentType, byteSize: stored.byteSize });
    } catch (error) {
      console.error("inbound media item skipped", {
        messageSid: args.messageSid,
        index: item.index,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return out;
}

/** Link every file of one message to a record. Never overwrites an existing link. */
export async function linkSmsMediaToRecord(
  db: SupabaseClient,
  args: { messageSid: string; linkedType: SmsMediaLinkedType; linkedId: string },
): Promise<void> {
  try {
    await db
      .from("sms_media_files")
      .update({ linked_type: args.linkedType, linked_id: args.linkedId })
      .eq("message_sid", args.messageSid)
      .is("linked_type", null);
  } catch {
    /* advisory */
  }
}

/** Download one stored file back as a data URL (what the record pages render). */
async function fileAsDataUrl(db: SupabaseClient, row: Pick<SmsMediaFileRow, "storage_path" | "content_type">): Promise<string | null> {
  if (!row.content_type.startsWith("image/")) return null;
  const { data, error } = await db.storage.from(SMS_MEDIA_BUCKET).download(row.storage_path);
  if (error || !data) return null;
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > SMS_MEDIA_MAX_BYTES) return null;
  return `data:${row.content_type};base64,${bytes.toString("base64")}`;
}

/**
 * Photos a resident texted just before filing a maintenance request: this
 * owner's unlinked files from the resident's phone in the last half hour (most
 * recent first). The caller adds them to the record and then links them with
 * `linkClaimedMedia`.
 */
export async function recentUnlinkedSmsMedia(
  db: SupabaseClient,
  args: { ownerUserId: string; senderPhone: string; withinMinutes?: number; limit?: number },
): Promise<SmsMediaFileRow[]> {
  const phoneKey = normalizeConsentPhone(args.senderPhone);
  if (!phoneKey) return [];
  const since = new Date(Date.now() - (args.withinMinutes ?? 30) * 60_000).toISOString();
  try {
    const { data, error } = await db
      .from("sms_media_files")
      .select(FILE_COLUMNS)
      .eq("sender_phone_key", phoneKey)
      .like("storage_path", `manager/${args.ownerUserId}/%`)
      .is("linked_type", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(args.limit ?? 6);
    if (error || !data) return [];
    return data as SmsMediaFileRow[];
  } catch {
    return [];
  }
}

export async function smsMediaDataUrls(db: SupabaseClient, rows: SmsMediaFileRow[]): Promise<string[]> {
  const urls: string[] = [];
  for (const row of rows) {
    const url = await fileAsDataUrl(db, row).catch(() => null);
    if (url) urls.push(url);
  }
  return urls;
}

export async function linkClaimedMedia(
  db: SupabaseClient,
  args: { ids: string[]; linkedType: SmsMediaLinkedType; linkedId: string },
): Promise<void> {
  if (args.ids.length === 0) return;
  try {
    await db
      .from("sms_media_files")
      .update({ linked_type: args.linkedType, linked_id: args.linkedId })
      .in("id", args.ids)
      .is("linked_type", null);
  } catch {
    /* advisory */
  }
}

const MAX_JOB_PHOTOS = 8;

/**
 * A vendor texted a photo on an open job: link it to the job (`vendor_job`) and
 * add it to the work order's completion photos so the record page shows it.
 * Scoped to the job's own manager; a job that is not this owner's is untouched.
 */
export async function attachVendorJobMedia(
  db: SupabaseClient,
  args: { ownerUserId: string; workOrderId: string | null | undefined; messageSid: string },
): Promise<{ linked: number }> {
  const workOrderId = String(args.workOrderId ?? "").trim();
  if (!workOrderId) return { linked: 0 };
  try {
    const { data: files, error } = await db
      .from("sms_media_files")
      .select(FILE_COLUMNS)
      .eq("message_sid", args.messageSid)
      .like("storage_path", `manager/${args.ownerUserId}/%`)
      .is("linked_type", null);
    if (error || !files?.length) return { linked: 0 };
    const rows = files as SmsMediaFileRow[];

    const { data: order } = await db
      .from("portal_work_order_records")
      .select("id, row_data")
      .eq("id", workOrderId)
      .eq("manager_user_id", args.ownerUserId)
      .maybeSingle();
    if (!order) return { linked: 0 };

    const dataUrls = await smsMediaDataUrls(db, rows);
    if (dataUrls.length > 0) {
      const rowData = (order.row_data ?? {}) as Record<string, unknown>;
      const current = Array.isArray(rowData.completionPhotoDataUrls)
        ? (rowData.completionPhotoDataUrls as unknown[]).filter((u): u is string => typeof u === "string")
        : [];
      const merged = [...current, ...dataUrls.filter((u) => !current.includes(u))].slice(0, MAX_JOB_PHOTOS);
      await db
        .from("portal_work_order_records")
        .update({ row_data: { ...rowData, completionPhotoDataUrls: merged } })
        .eq("id", workOrderId)
        .eq("manager_user_id", args.ownerUserId);
    }
    await linkClaimedMedia(db, { ids: rows.map((r) => r.id), linkedType: "vendor_job", linkedId: workOrderId });
    return { linked: rows.length };
  } catch {
    return { linked: 0 };
  }
}
