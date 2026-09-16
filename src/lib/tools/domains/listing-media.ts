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

    const dedupeKey = `apply_listing_photos:${ctx.landlordId}:${rec.id}:${auditDayBucket()}:${input.placements.length}`;
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
