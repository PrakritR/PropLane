import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestListingPhoto, type IngestListingPhotoResult } from "@/lib/listing-photo-ingest.server";
import { buildCommandContext } from "@/lib/manager-sms-commands/context.server";
import { loadFlow } from "@/lib/manager-sms-commands/listing-flow.server";
import {
  hasPropertyHint,
  hasRoomHint,
  resolveTarget,
  type CatalogProperty,
  type CatalogRoom,
} from "@/lib/manager-sms-commands/resolve-target";
import { linkClaimedMedia, type SmsMediaFileRow } from "@/lib/one-number/inbound-media.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { buildManagerSmsRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import { executeWriteTool } from "@/lib/tools/registry";

/**
 * MMS photos from a verified manager/staff phone -> the right listing's gallery (design-1112 section 4).
 *
 * Which house, in order: the house the text names ("5259 room 4"), the house of the open create-a-listing flow, the last
 * house photos were filed to in the past 15 minutes. Unclear means ONE question and the photos are held (still unlinked
 * in `sms_media_files`, readable for 30 minutes), never a guess. A named room files into that room's gallery, otherwise
 * the house gallery. The original always stays in `sms-media`; the web copy is `ingestListingPhoto`'s.
 */

export const PHOTO_CONTEXT_WINDOW_MS = 15 * 60 * 1000;
export const PHOTO_HOLD_WINDOW_MS = 30 * 60 * 1000;
export const ASK_WHICH_HOUSE = "Which house are these for? (and a room, if they are room photos)";

const FILE_COLUMNS = "id, message_sid, media_index, workspace_id, sender_phone_key, storage_path, content_type, byte_size, linked_type, linked_id, created_at";

export type PhotoFilingInput = {
  staffPhoneE164: string;
  actorUserId: string;
  workspaceIds: string[];
  body: string;
  messageSid: string;
  mediaCount: number;
};

export type PhotoFilingDeps = {
  buildContext: (db: SupabaseClient, input: { actorUserId: string; workspaceId: string }) => Promise<AgentContext | null>;
  ingest: typeof ingestListingPhoto;
  now: () => Date;
};

export const defaultPhotoDeps: PhotoFilingDeps = { buildContext: buildCommandContext, ingest: ingestListingPhoto, now: () => new Date() };

type Reply = { handled: false } | { handled: true; reply: string };

async function unlinkedImages(db: SupabaseClient, staffKey: string, now: Date): Promise<SmsMediaFileRow[] | null> {
  const since = new Date(now.getTime() - PHOTO_HOLD_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("sms_media_files")
    .select(FILE_COLUMNS)
    .eq("sender_phone_key", staffKey)
    .is("linked_type", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(24);
  if (error) return null;
  return ((data ?? []) as SmsMediaFileRow[]).filter((row) => String(row.content_type ?? "").toLowerCase().startsWith("image/"));
}

/** The house (and room) the last photos were filed to, within the window: `linked_id` is `propertyId[:roomId]`. */
async function lastFiledTarget(db: SupabaseClient, staffKey: string, now: Date): Promise<{ propertyId: string; roomId: string | null } | null> {
  const since = new Date(now.getTime() - PHOTO_CONTEXT_WINDOW_MS).toISOString();
  const { data, error } = await db
    .from("sms_media_files")
    .select("linked_id, created_at")
    .eq("sender_phone_key", staffKey)
    .eq("linked_type", "listing")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  const id = String(((data as Array<Record<string, unknown>> | null) ?? [])[0]?.linked_id ?? "");
  if (error || !id) return null;
  const [propertyId, roomId] = id.split(":");
  return propertyId ? { propertyId, roomId: roomId || null } : null;
}

function mediaOwnerOf(row: SmsMediaFileRow): string | null {
  return /^manager\/([^/]+)\//.exec(row.storage_path)?.[1] ?? null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "5259 Brooklyn Ave NE, Room 4" / "5259 Brooklyn Ave NE". */
export function placeLabel(property: CatalogProperty, room: CatalogRoom | null): string {
  return room ? `${property.label}, ${room.name}` : property.label;
}

export async function filePhotos(
  db: SupabaseClient,
  input: PhotoFilingInput,
  catalog: CatalogProperty[] | null,
  deps: PhotoFilingDeps = defaultPhotoDeps,
): Promise<Reply> {
  const now = deps.now();
  const staffKey = normalizeConsentPhone(input.staffPhoneE164);
  if (!staffKey || !catalog) return { handled: false };
  const media = await unlinkedImages(db, staffKey, now);
  // Not photos at all (no files for this text, nothing held): the manager agent answers as before.
  if (!media || media.length === 0) return { handled: false };

  const text = input.body.trim();
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const flow = await loadFlow(db, staffKey, now).catch(() => null);
  const flowProperty = flow?.draft.draftPropertyId ? byId.get(flow.draft.draftPropertyId) ?? null : null;
  const last = await lastFiledTarget(db, staffKey, now).catch(() => null);
  const lastProperty = last ? byId.get(last.propertyId) ?? null : null;
  const contextProperty = flowProperty ?? lastProperty;

  let property: CatalogProperty | null = null;
  let room: CatalogRoom | null = null;
  const namesHouse = hasPropertyHint(text);
  const namesRoom = hasRoomHint(text);
  if (namesHouse || namesRoom) {
    // A bare "room 4" means a room of the house in context; a named house always wins over context.
    const pool = !namesHouse && contextProperty ? [contextProperty] : catalog;
    const resolved = resolveTarget(text, pool, "photos");
    // A follow-up text with no photos of its own only counts when it really answers "which house": a text that matches
    // nothing is some other request and goes on to the manager agent, with the photos still held.
    if (resolved.kind === "ask" && input.mediaCount === 0 && (resolved.reason === "no_match" || text.length > 60)) return { handled: false };
    if (resolved.kind === "ask") return { handled: true, reply: `${resolved.question} I am holding ${plural(media.length, "photo")} until you say.` };
    property = resolved.property;
    room = resolved.room;
  } else if (input.mediaCount === 0) {
    return { handled: false };
  } else if (contextProperty) {
    property = contextProperty;
    room = lastProperty && !flowProperty && last?.roomId ? lastProperty.rooms.find((r) => r.id === last.roomId) ?? null : null;
  } else if (catalog.length === 1) {
    property = catalog[0]!;
  }
  if (!property) return { handled: true, reply: `${ASK_WHICH_HOUSE} I am holding ${plural(media.length, "photo")} until you say.` };
  if (!input.workspaceIds.includes(property.workspaceId)) return { handled: false };

  const ctx = await deps.buildContext(db, { actorUserId: input.actorUserId, workspaceId: property.workspaceId });
  const registry = ctx ? buildManagerSmsRegistry(ctx.managerSmsAccess) : null;
  if (!ctx || !registry?.has("apply_listing_photos")) {
    return { handled: true, reply: "I can not add photos by text for your access. Please add them in PropLane." };
  }

  const filed: Array<{ row: SmsMediaFileRow; result: Extract<IngestListingPhotoResult, { ok: true }> }> = [];
  let unreadable = 0;
  for (const row of media) {
    const mediaOwnerUserId = mediaOwnerOf(row) ?? ctx.landlordId;
    const result = await deps.ingest(db, { ownerUserId: property.ownerUserId, propertyId: property.id, mediaRow: row, mediaOwnerUserId });
    if (result.ok) filed.push({ row, result });
    else unreadable += 1;
  }
  if (filed.length === 0) {
    return { handled: true, reply: unreadable > 0 ? `I could not read ${plural(unreadable, "photo")}. Try sending them again.` : ASK_WHICH_HOUSE };
  }

  const placements = filed.map(({ result }) => ({
    photoUrl: result.publicUrl,
    target: room ? ("room" as const) : ("house" as const),
    ...(room ? { targetId: room.id } : {}),
  }));
  let applied = 0;
  let skipped = 0;
  const placedIds: string[] = [];
  for (let at = 0; at < placements.length; at += 12) {
    const chunk = placements.slice(at, at + 12);
    const executed = await executeWriteTool(registry, ctx, "apply_listing_photos", { propertyId: property.id, placements: chunk });
    if (!executed.ok) {
      return { handled: true, reply: `I could not add the photos to ${placeLabel(property, room)}. ${executed.error}`.slice(0, 300) };
    }
    const summary = (executed.result.resultSummary ?? {}) as { applied?: number; skipped?: number };
    applied += Number(summary.applied ?? chunk.length);
    skipped += Number(summary.skipped ?? 0);
    placedIds.push(...filed.slice(at, at + 12).map(({ row }) => row.id));
  }
  await linkClaimedMedia(db, { ids: placedIds, linkedType: "listing", linkedId: room ? `${property.id}:${room.id}` : property.id });

  const small = filed.filter(({ result }) => result.small);
  const notes: string[] = [];
  if (small.length > 0) {
    const edge = Math.min(...small.map(({ result }) => result.sourceLongEdge));
    notes.push(`${plural(small.length, "photo")} ${small.length === 1 ? "is" : "are"} small (${edge} px) and may be rejected by listing sites.`);
  }
  if (skipped > 0) notes.push(`${plural(skipped, "photo")} could not be added (duplicate or the gallery is full).`);
  if (unreadable > 0) notes.push(`${plural(unreadable, "photo")} could not be read.`);
  return { handled: true, reply: [`Added ${plural(applied, "photo")} to ${placeLabel(property, room)}.`, ...notes].join(" ") };
}
