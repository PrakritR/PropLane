import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { propertyInAgentWorkspace, SWITCH_WORKSPACE_ASSISTANT_REPLY } from "@/lib/agent/manager-workspace-scope";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import {
  applyListingPhotoPlacements,
  listingMediaInventoryFromSubmission,
  normalizeListingPhotoUrl,
} from "@/lib/listing-media-placement.server";
import { ingestListingPhoto } from "@/lib/listing-photo-ingest.server";
import {
  loadSenderRecentImages,
  loadSuggestionFiles,
  mediaOwnerOfRow,
  verifiedPhoneOfActor,
} from "@/lib/listing-photo-suggestions.server";
import { linkClaimedMedia, type SmsMediaFileRow } from "@/lib/one-number/inbound-media.server";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

type RawPropertyRecord = {
  id: string;
  status: string | null;
  row_data: unknown;
  property_data: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function loadOwnedPropertyRecord(ctx: AgentContext, propertyId: string): Promise<RawPropertyRecord | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, status, row_data, property_data")
    .eq("id", id)
    .eq("manager_user_id", ctx.landlordId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (((data ?? []) as RawPropertyRecord[])[0] as RawPropertyRecord | undefined) ?? null;
  if (!rec) return null;
  if (!propertyInAgentWorkspace(ctx.workspace, rec.id)) {
    throw new Error(SWITCH_WORKSPACE_ASSISTANT_REPLY);
  }
  return rec;
}

function listingSubmissionOf(rec: RawPropertyRecord): Record<string, unknown> | null {
  return (
    asObject(asObject(rec.property_data)?.listingSubmission) ?? asObject(asObject(rec.row_data)?.submission)
  );
}

function listingSubmissionFromRecord(rec: RawPropertyRecord): ManagerListingSubmissionV1 | null {
  const raw = listingSubmissionOf(rec);
  if (!raw) return null;
  return normalizeManagerListingSubmissionV1(raw as ManagerListingSubmissionV1);
}

function writeSubmissionToRecordPayloads(
  rec: RawPropertyRecord,
  submission: ManagerListingSubmissionV1,
): { row_data: unknown; property_data: unknown } {
  const normalized = normalizeManagerListingSubmissionV1(submission);
  const rowData = asObject(rec.row_data);
  const propertyData = asObject(rec.property_data);
  const nextRow: Record<string, unknown> | null = rowData ? { ...rowData } : null;
  const nextProp: Record<string, unknown> | null = propertyData ? { ...propertyData } : null;
  if (nextRow) {
    if (asObject(nextRow.submission) || "submission" in nextRow) {
      nextRow.submission = normalized;
    }
  }
  if (nextProp) {
    nextProp.listingSubmission = normalized;
  }
  return { row_data: nextRow ?? rec.row_data, property_data: nextProp ?? rec.property_data };
}

const placementSchema = z
  .object({
    photoUrl: z.string().min(1).describe("Public listing-photos URL from chat upload."),
    target: z
      .enum(["house", "room", "bathroom", "shared_space"])
      .describe("Where to place the photo in the listing wizard."),
    targetId: z
      .string()
      .optional()
      .describe("Room, bathroom, or shared-space id from get_listing_media_inventory or modal context."),
    label: z.string().optional().describe("Short human label for the preview, e.g. 'Primary bathroom'."),
  })
  .strict();

export const getListingMediaInventoryTool = defineTool({
  name: "get_listing_media_inventory",
  description:
    "Read room, bathroom, and shared-space ids and photo counts for a listing so you can place uploaded images in the correct slots. Use in the Edit/New listing modal when propertyId is in context.",
  kind: "read",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("Listing property id from modal context or list_properties."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found for this account.");
    const sub = listingSubmissionFromRecord(rec);
    if (!sub) throw new Error("This property has no listing submission yet.");
    const inv = listingMediaInventoryFromSubmission(sub);
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    return {
      propertyId: rec.id,
      title: str(src, "buildingName") ?? str(src, "address") ?? rec.id,
      status: rec.status,
      inventory: inv,
      guidance:
        "Classify each uploaded image, then propose apply_listing_photos with one placement per URL. Use house for exterior/whole-home shots; use room/bathroom/shared_space with the matching targetId.",
    };
  },
});

export const applyListingPhotosTool = defineWriteTool({
  name: "apply_listing_photos",
  description:
    "Place uploaded listing photos into the correct house gallery, room, bathroom, or shared-space slots on an open listing. Use after visually classifying images the manager attached in the listing wizard. Pass propertyId from modal context and one placement per photo URL.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("Listing property id from modal context."),
      placements: z
        .array(placementSchema)
        .min(1)
        .max(12)
        .describe("One entry per photo URL with the correct target and targetId."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found for this account.");
    const sub = listingSubmissionFromRecord(rec);
    if (!sub) throw new Error("This property has no listing submission to update.");

    const normalizedPlacements = input.placements.map((p) => ({
      ...p,
      photoUrl: normalizeListingPhotoUrl(p.photoUrl) ?? p.photoUrl,
    }));
    if (normalizedPlacements.every((p) => !normalizeListingPhotoUrl(p.photoUrl))) {
      throw new Error("No valid listing-photo URLs in placements — use URLs from the chat upload note.");
    }

    const { applied, skipped } = applyListingPhotoPlacements(sub, normalizedPlacements);
    if (!applied.length) {
      throw new Error(
        skipped.length
          ? `Could not place photos: ${skipped.map((s) => s.reason).join(", ")}`
          : "No photos to place.",
      );
    }

    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "buildingName") ?? str(src, "address") ?? rec.id;
    const fields = [
      { label: "Listing id", value: rec.id },
      ...applied.map((a) => ({
        label: a.label,
        value: `${a.target}${a.targetId ? ` (${a.targetId})` : ""}`,
      })),
    ];

    return {
      kind: "apply_listing_photos",
      title: "Place listing photos",
      summary: `Add ${applied.length} photo${applied.length === 1 ? "" : "s"} on ${title}.`,
      fields,
      confirmLabel: "Add photos",
      ...(skipped.length
        ? { warnings: [`${skipped.length} photo(s) skipped (duplicate, full slot, or unknown target).`] }
        : {}),
    };
  },
  handler: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found.");
    const sub = listingSubmissionFromRecord(rec);
    if (!sub) throw new Error("Could not load listing submission.");

    // Keyed on WHICH photos (not just how many): a second batch of the same size on the same day is a different action,
    // which matters for photos texted in as they are taken.
    const placementDigest = createHash("sha256")
      .update(JSON.stringify(input.placements.map((p) => [p.photoUrl, p.target, p.targetId ?? ""])))
      .digest("hex")
      .slice(0, 16);
    const dedupeKey = `apply_listing_photos:${ctx.landlordId}:${rec.id}:${auditDayBucket()}:${placementDigest}`;
    const audit = await writeAuditLog(ctx, {
      action: "apply_listing_photos",
      toolName: "apply_listing_photos",
      inputSummary: { propertyId: rec.id, count: input.placements.length },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those photos were already placed on this listing today." };
      throw new Error("Could not record the action; photos were not saved.");
    }

    const { submission, applied, skipped } = applyListingPhotoPlacements(sub, input.placements);
    if (!applied.length) {
      await updateAuditResult(ctx, dedupeKey, { error: "nothing_applied" }, { clearDedupeKey: true });
      throw new Error("No photos could be placed — check target ids and URLs.");
    }

    const payloads = writeSubmissionToRecordPayloads(rec, submission);
    // No plan-quota gate: this patches only `row_data` / `property_data` and
    // never writes `status`, so it cannot move a record into a listing slot.
    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        row_data: payloads.row_data,
        property_data: payloads.property_data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { propertyId: rec.id, applied: applied.length, skipped: skipped.length });
    const lines = applied.map((a) => `${a.label}`);
    return {
      reply: `Placed ${applied.length} photo${applied.length === 1 ? "" : "s"} on the listing (${lines.join(", ")}). The wizard will refresh with the new images.`,
      resultSummary: { propertyId: rec.id, applied: applied.length, skipped: skipped.length },
    };
  },
});

type PlaceTarget = "house" | "room" | "bathroom" | "shared_space";

/** Where the photos go, resolved against the listing's own inventory (a named slot that is not there is refused). */
function resolvePlace(sub: ManagerListingSubmissionV1, target: PlaceTarget, targetId: string | undefined): string {
  if (target === "house") return "House gallery";
  const inv = listingMediaInventoryFromSubmission(sub);
  const pool = target === "room" ? inv.rooms : target === "bathroom" ? inv.bathrooms : inv.sharedSpaces;
  const hit = pool.find((item) => item.id === targetId);
  if (!hit) throw new Error("Name which room, bathroom or shared space these photos are for.");
  return hit.label;
}

/**
 * Shared preview for the two SMS photo tools: "Add 3 photos to 5257 Brooklyn \u00b7 Room 7" (the existing pending-action
 * confirm turns it into a YES). Throws the user-facing reason when there is nothing to place.
 */
function placePreview(ctx: AgentContext, rec: RawPropertyRecord, kind: string, files: SmsMediaFileRow[], target: PlaceTarget, targetId: string | undefined) {
  void ctx;
  const sub = listingSubmissionFromRecord(rec);
  if (!sub) throw new Error("This property has no listing submission to update.");
  const place = resolvePlace(sub, target, targetId);
  const src = asObject(rec.property_data) ?? asObject(rec.row_data);
  const title = str(src, "buildingName") ?? str(src, "address") ?? rec.id;
  return {
    kind,
    title: "Add photos to a listing",
    summary: `Add ${files.length} photo${files.length === 1 ? "" : "s"} to ${title} \u00b7 ${place}.`,
    fields: [{ label: "Listing", value: title }, { label: "Where", value: place }, { label: "Photos", value: String(files.length) }],
    confirmLabel: "Add photos",
  };
}

/**
 * Shared handler core: copy each file to the public listing-photos bucket (`ingestListingPhoto`) and place the copies
 * through `apply_listing_photos`, the one placement path. Only rows the caller's tool selected server-side are passed in.
 */
async function placeFilesOnListing(
  ctx: AgentContext,
  rec: RawPropertyRecord,
  files: SmsMediaFileRow[],
  target: PlaceTarget,
  targetId: string | undefined,
  link: { ids: string[]; linkedId: string; claim: "unlinked" | "suggested" },
) {
  const placements: Array<z.infer<typeof placementSchema>> = [];
  let unreadable = 0;
  for (const row of files) {
    const out = await ingestListingPhoto(ctx.db, {
      ownerUserId: ctx.landlordId,
      propertyId: rec.id,
      mediaRow: row,
      mediaOwnerUserId: mediaOwnerOfRow(row) ?? ctx.landlordId,
    });
    if (!out.ok) {
      unreadable += 1;
      continue;
    }
    placements.push({ photoUrl: out.publicUrl, target, ...(target !== "house" && targetId ? { targetId } : {}) });
  }
  if (placements.length === 0) throw new Error("None of those photos could be read.");
  const applied = (await applyListingPhotosTool.handler(ctx, { propertyId: rec.id, placements })) as { reply: string; resultSummary?: { applied?: number } };
  if (link.claim === "unlinked") {
    await linkClaimedMedia(ctx.db, { ids: link.ids, linkedType: "listing", linkedId: link.linkedId });
  } else {
    await ctx.db.from("sms_media_files").update({ linked_id: link.linkedId }).in("id", link.ids).eq("linked_type", "listing");
  }
  return { reply: unreadable ? `${applied.reply} ${unreadable} photo(s) could not be read.` : applied.reply, resultSummary: applied.resultSummary };
}

const placeTargetSchema = {
  propertyId: z.string().min(1),
  target: z.enum(["house", "room", "bathroom", "shared_space"]).default("house"),
  targetId: z.string().optional().describe("Required for room, bathroom and shared_space (ids from get_listing_media_inventory)."),
};

/**
 * The manager's one step for photos a RESIDENT texted in (`suggest_listing_photos`): the suggestion's own images (found by
 * its id under this manager's bucket path, never a URL from the model) are placed through the shared core.
 */
export const placeResidentSuggestedPhotosTool = defineWriteTool({
  name: "place_resident_suggested_photos",
  description:
    "Place the photos a resident texted for a listing (a 'Resident sent listing photos' notice carries the suggestion id) onto one of the manager's listings. Pass the suggestion id, the propertyId, and where they go: house gallery, or a room / bathroom / shared space with its targetId from get_listing_media_inventory. Ask one short question if the house or room is unclear.",
  inputSchema: z
    .object({
      suggestionId: z.string().regex(/^[a-f0-9]{6,32}$/).describe("The id in the resident's photo notice."),
      ...placeTargetSchema,
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found for this account.");
    const files = await loadSuggestionFiles(ctx.db, { managerUserId: ctx.landlordId, suggestionId: input.suggestionId });
    if (files.length === 0) throw new Error("No photos were found for that suggestion on this account.");
    return placePreview(ctx, rec, "place_resident_suggested_photos", files, input.target ?? "house", input.targetId);
  },
  handler: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found.");
    const files = await loadSuggestionFiles(ctx.db, { managerUserId: ctx.landlordId, suggestionId: input.suggestionId });
    if (files.length === 0) throw new Error("No photos were found for that suggestion on this account.");
    return placeFilesOnListing(ctx, rec, files, input.target ?? "house", input.targetId, { ids: files.map((f) => f.id), linkedId: rec.id, claim: "suggested" });
  },
});

/**
 * "This is 5257 room 7" / "post these to 4709A kitchen": the manager (or PropLane staff seat) texted photos and names
 * where they go. The photos are the ones THIS actor's own verified phone sent in the last 30 minutes, found server-side
 * (`sms_media_files.sender_phone_key`), never a URL or path from the model. The listing must be one the actor's scope owns.
 */
export const placeMyTextedPhotosTool = defineWriteTool({
  name: "place_my_texted_photos",
  description:
    "Place the photos the user themself just texted (last 30 minutes) onto one of their listings: \"this is 5257 room 7\", \"post these to 4709A kitchen\". Resolve the house with list_properties and the room, bathroom or shared space (kitchen, living room) with get_listing_media_inventory, then pass propertyId, target and targetId. Never pass a photo URL: the photos are found for you. Ask one short question if the house or room is unclear.",
  inputSchema: z
    .object({
      ...placeTargetSchema,
      mediaIds: z
        .array(z.string().min(1))
        .optional()
        .describe("Server-set by the preview: the exact photos the confirmation card counted. Never pass this."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found for this account.");
    const phone = await verifiedPhoneOfActor(ctx.db, ctx.userId);
    const files = phone ? await loadSenderRecentImages(ctx.db, { senderPhoneE164: phone }) : [];
    if (files.length === 0) throw new Error("I do not see photos from you in the last half hour. Text the photos again, then tell me the house.");
    return {
      ...placePreview(ctx, rec, "place_my_texted_photos", files, input.target ?? "house", input.targetId),
      // Photos arrive as they are taken, so "the last half hour" is a different set by the time YES comes back. The
      // approved set is pinned here; the handler places those and never a photo the card did not count.
      confirmedInput: { ...input, mediaIds: files.map((f) => f.id) },
    };
  },
  handler: async (ctx, input) => {
    const pinned = new Set(input.mediaIds ?? []);
    if (pinned.size === 0) throw new Error("Review the photos before adding them.");
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No listing with that id was found.");
    const phone = await verifiedPhoneOfActor(ctx.db, ctx.userId);
    // The same read the preview made: it is what re-verifies every pinned id is still this actor's own verified
    // phone's, still unlinked and still an image. The ids are a pin, never authorization.
    const waiting = phone ? await loadSenderRecentImages(ctx.db, { senderPhoneE164: phone }) : [];
    const files = waiting.filter((row) => pinned.has(row.id));
    if (files.length === 0) throw new Error("Those photos are no longer waiting to be placed. Text them again, then tell me the house.");
    const target = input.target ?? "house";
    const placed = await placeFilesOnListing(ctx, rec, files, target, input.targetId, {
      ids: files.map((f) => f.id),
      linkedId: target === "room" && input.targetId ? `${rec.id}:${input.targetId}` : rec.id,
      claim: "unlinked",
    });
    const arrivedSince = waiting.length - files.length;
    return arrivedSince > 0
      ? { ...placed, reply: `${placed.reply} ${arrivedSince} more photo${arrivedSince === 1 ? "" : "s"} arrived after that — tell me where they go to add them.` }
      : placed;
  },
});
