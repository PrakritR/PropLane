/**
 * Inbound MMS media capture. Twilio media URLs require HTTP Basic auth and are
 * eventually deleted from Twilio, so we copy each attachment into the private
 * `sms-media` bucket. The durable identifier is the bucket PATH — signed URLs
 * expire, so only the path is persisted (DB rows, inbox bodies) and fresh
 * signed URLs are minted at read time via /api/sms-media, the same
 * private-bucket model as manager-documents. The signed URL returned here is
 * for the immediate outbound legs only (SMS relay, email body).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "video/3gpp": "3gp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "text/vcard": "vcf",
};

export const SMS_MEDIA_BUCKET = "sms-media";
const OUTBOUND_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;
const READ_SIGNED_URL_TTL_SECONDS = 60 * 10;

export type StoredSmsMedia = {
  /** Bucket path — the durable identifier persisted in DB rows / inbox bodies. */
  path: string;
  /** 7-day signed URL for the immediate outbound SMS/email legs only. */
  signedUrl: string;
};

/** Extract MediaUrl0..N from a parsed Twilio webhook payload. */
export function twilioMediaUrls(params: Record<string, string>): string[] {
  const count = Math.min(Number(params.NumMedia ?? 0) || 0, 10);
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    const url = String(params[`MediaUrl${i}`] ?? "").trim();
    if (url.startsWith("https://")) urls.push(url);
  }
  return urls;
}

/** In-app link that mints a fresh signed URL at read time (never expires itself). */
export function smsMediaAppUrl(path: string): string {
  return `/api/sms-media?path=${encodeURIComponent(path)}`;
}

/** Short-lived signed URL for read-time access after an ownership check. */
export async function createSmsMediaSignedUrl(
  db: SupabaseClient,
  path: string,
): Promise<string | null> {
  const { data } = await db.storage
    .from(SMS_MEDIA_BUCKET)
    // `download: true` makes the storage answer `Content-Disposition: attachment`:
    // the bytes are sender-supplied, so they are never rendered as an on-origin
    // document. An <img> preview is a subresource load and is unaffected.
    .createSignedUrl(path, READ_SIGNED_URL_TTL_SECONDS, { download: true });
  return data?.signedUrl ?? null;
}

/** File extension for an allow-listed MMS content type, else null (outside the bucket allowlist). */
export function smsMediaExtensionForMime(mime: string): string | null {
  return EXT_BY_MIME[mime.split(";")[0].trim().toLowerCase()] ?? null;
}

/** Largest attachment kept; anything bigger is skipped. */
export const SMS_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Write one already-downloaded attachment into the private bucket under the
 * owning manager's folder. The path (`manager/<owner>/<sid>/<index>.<ext>`) is
 * the durable identifier. Returns null when the type is outside the allowlist,
 * the size is out of range, or the upload fails.
 */
export async function storeInboundMediaBytes(
  db: SupabaseClient,
  args: { managerUserId: string; messageSid: string; index: number; bytes: Buffer; mime: string },
): Promise<{ path: string; contentType: string; byteSize: number } | null> {
  const mime = args.mime.split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) return null;
  if (args.bytes.byteLength === 0 || args.bytes.byteLength > SMS_MEDIA_MAX_BYTES) return null;
  const path = `manager/${args.managerUserId}/${args.messageSid}/${args.index}.${ext}`;
  const { error } = await db.storage
    .from(SMS_MEDIA_BUCKET)
    .upload(path, args.bytes, { contentType: mime, upsert: true });
  if (error) return null;
  return { path, contentType: mime, byteSize: args.bytes.byteLength };
}

/**
 * Copy Twilio-hosted MMS attachments into the sms-media bucket under the
 * owning manager's folder. Best-effort per attachment — a failed fetch skips
 * that item rather than dropping the whole message.
 */
export async function storeInboundMedia(
  db: SupabaseClient,
  args: { managerUserId: string; messageSid: string; mediaUrls: string[] },
): Promise<StoredSmsMedia[]> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken || args.mediaUrls.length === 0) return [];
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const stored: StoredSmsMedia[] = [];
  for (const [index, url] of args.mediaUrls.entries()) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Basic ${basicAuth}` } });
      if (!res.ok) continue;
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const bytes = Buffer.from(await res.arrayBuffer());
      const kept = await storeInboundMediaBytes(db, {
        managerUserId: args.managerUserId,
        messageSid: args.messageSid,
        index,
        bytes,
        mime,
      });
      if (!kept) continue;

      const { data: signed } = await db.storage
        .from(SMS_MEDIA_BUCKET)
        .createSignedUrl(kept.path, OUTBOUND_SIGNED_URL_TTL_SECONDS);
      if (signed?.signedUrl) stored.push({ path: kept.path, signedUrl: signed.signedUrl });
    } catch {
      // best-effort: skip this attachment
    }
  }
  return stored;
}
