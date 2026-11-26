import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { linkClaimedMedia, type SmsMediaFileRow } from "@/lib/one-number/inbound-media.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { smsMediaAppUrl } from "@/lib/sms-media.server";

/**
 * A resident's photos of their own house, offered to the manager for the listing.
 *
 * A resident NEVER edits a listing. Their texted photos stay in the private `sms-media` bucket, are tagged
 * `listing` / `suggested:<id>` in `sms_media_files`, and reach the manager as one Assistant notice whose links go through
 * the signed `/api/sms-media` route. The manager places them with `place_resident_suggested_photos`, which copies them to
 * the public bucket and uses the one `apply_listing_photos` path. Only the files THIS sender texted to THIS manager's number
 * in the last 30 minutes are ever considered; a model never supplies a path or a URL.
 */

export const SUGGESTION_WINDOW_MS = 30 * 60 * 1000;
export const SUGGESTION_MAX_PHOTOS = 12;
export const SUGGESTION_LINK_PREFIX = "suggested:";

const FILE_COLUMNS = "id, message_sid, media_index, workspace_id, sender_phone_key, storage_path, content_type, byte_size, linked_type, linked_id, created_at";

/** The sender's own recent unlinked images (oldest first), optionally under one manager's bucket path. */
export async function loadSenderRecentImages(
  db: SupabaseClient,
  args: { senderPhoneE164: string; managerUserId?: string; now?: Date },
): Promise<SmsMediaFileRow[]> {
  const key = normalizeConsentPhone(args.senderPhoneE164);
  const manager = args.managerUserId?.trim() ?? null;
  if (!key || (manager !== null && !/^[A-Za-z0-9_-]+$/.test(manager))) return [];
  const since = new Date((args.now ?? new Date()).getTime() - SUGGESTION_WINDOW_MS).toISOString();
  let query = db
    .from("sms_media_files")
    .select(FILE_COLUMNS)
    .eq("sender_phone_key", key);
  // A resident's photos are read only under the manager they texted; a manager/staff sender's own photos sit under the
  // number's owner, which a delegated or PropLane-line text does not always share with the actor, so only the phone binds them.
  if (manager !== null) query = query.like("storage_path", `manager/${manager}/%`);
  const { data, error } = await query
    .is("linked_type", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(SUGGESTION_MAX_PHOTOS);
  if (error) return [];
  return ((data ?? []) as SmsMediaFileRow[]).filter((row) => String(row.content_type ?? "").toLowerCase().startsWith("image/"));
}

/** A stable short id for one resident's offered batch (same photos -> same id, so a retry never duplicates). */
export function suggestionIdFor(residentUserId: string, files: Array<Pick<SmsMediaFileRow, "id">>): string {
  const digest = createHash("sha256").update(`${residentUserId}:${files.map((f) => f.id).sort().join(",")}`).digest("hex");
  return digest.slice(0, 10);
}

export function suggestionNoticeText(args: { residentName: string; note: string; count: number; suggestionId: string; links: string[] }): string {
  const who = args.residentName.trim() || "A resident";
  const note = args.note.trim().slice(0, 200);
  return [
    `${who} sent ${args.count} photo${args.count === 1 ? "" : "s"} for a listing${note ? ` (they wrote: "${note}")` : ""}.`,
    ...args.links.map((link, i) => `Photo ${i + 1}: ${link}`),
    `To post them, tell the assistant: place suggestion ${args.suggestionId} on <house>.`,
  ].join("\n");
}

export type SuggestResult = { ok: true; count: number; suggestionId: string; notified: boolean } | { ok: false; error: "no_photos" | "not_linked" };

/**
 * Tag the sender's recent photos as a suggestion and write the manager's notice. The listing is never read or written.
 * `origin` is the canonical site origin; `managerUserId` comes from the resident's own authenticated scope.
 */
export async function recordListingPhotoSuggestion(
  db: SupabaseClient,
  args: { senderPhoneE164: string; managerUserId: string; residentUserId: string; residentName: string; note: string; origin: string; now?: Date },
): Promise<SuggestResult> {
  const files = await loadSenderRecentImages(db, { senderPhoneE164: args.senderPhoneE164, managerUserId: args.managerUserId, now: args.now });
  if (files.length === 0) return { ok: false, error: "no_photos" };
  const suggestionId = suggestionIdFor(args.residentUserId, files);
  await linkClaimedMedia(db, { ids: files.map((f) => f.id), linkedType: "listing", linkedId: `${SUGGESTION_LINK_PREFIX}${suggestionId}` });
  const links = files.map((f) => `${args.origin}${smsMediaAppUrl(f.storage_path)}`);
  let notified = false;
  try {
    const result = await notifyManagerFromAgent(db, {
      landlordId: args.managerUserId,
      subject: "Resident sent listing photos",
      text: suggestionNoticeText({ residentName: args.residentName, note: args.note, count: files.length, suggestionId, links }),
      externalText: "A resident sent photos for a listing.",
      threadType: "resident_listing_photos",
      category: "messages",
      notify: { push: true, sms: false },
      idempotencyKey: `resident-listing-photos:${suggestionId}:${args.managerUserId}`,
    });
    notified = result.delivered && !result.suppressed;
  } catch (error) {
    console.error("resident listing photo notice failed", error instanceof Error ? error.message : "unknown");
  }
  return { ok: true, count: files.length, suggestionId, notified };
}

/** The photos of one suggestion, only under this manager's own bucket path. */
export async function loadSuggestionFiles(db: SupabaseClient, args: { managerUserId: string; suggestionId: string }): Promise<SmsMediaFileRow[]> {
  const manager = args.managerUserId.trim();
  const id = args.suggestionId.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(manager) || !/^[a-f0-9]{6,32}$/.test(id)) return [];
  const { data, error } = await db
    .from("sms_media_files")
    .select(FILE_COLUMNS)
    .eq("linked_type", "listing")
    .eq("linked_id", `${SUGGESTION_LINK_PREFIX}${id}`)
    .like("storage_path", `manager/${manager}/%`)
    .order("created_at", { ascending: true })
    .limit(SUGGESTION_MAX_PHOTOS);
  if (error) return [];
  return ((data ?? []) as SmsMediaFileRow[]).filter((row) => String(row.content_type ?? "").toLowerCase().startsWith("image/"));
}

/** The verified phone of the authenticated actor (never model input); null when unverified or unreadable. */
export async function verifiedPhoneOfActor(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.from("profiles").select("phone, phone_verified_at").eq("id", userId).maybeSingle();
  if (error || !data) return null;
  const row = data as { phone?: string | null; phone_verified_at?: string | null };
  if (!row.phone || !row.phone_verified_at) return null;
  return normalizeConsentPhone(row.phone) ? row.phone : null;
}

export function mediaOwnerOfRow(row: Pick<SmsMediaFileRow, "storage_path">): string | null {
  return /^manager\/([^/]+)\//.exec(row.storage_path)?.[1] ?? null;
}
