import { z } from "zod";
import { submissionToDraftAdminRow } from "@/lib/demo-admin-property-inventory";
import { draftIdFor } from "@/lib/one-number/onboarding/house-draft.server";
import { submissionFromImportedProperty } from "@/lib/property-import/to-submission";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import {
  LISTING_CREATION_CHECKLIST,
  buildListingSubmissionFromDraftInput,
  upsertManagerListingDraft,
  type ListingDraftToolInput,
} from "@/lib/listing-draft-agent.server";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const listingDraftFields = {
  buildingName: z.string().min(1).describe("Listing title / building name."),
  address: z.string().min(1).describe("Street address."),
  zip: z.string().optional().describe("ZIP code."),
  neighborhood: z.string().optional().describe("Neighborhood shown on the listing."),
  beds: z.number().int().min(1).max(20).describe("Number of bedrooms / rentable rooms."),
  baths: z.number().min(0).max(20).describe("Number of bathrooms."),
  monthlyRentUsd: z.number().positive().describe("Monthly rent in US dollars (first room or entire home)."),
  tagline: z.string().optional().describe("Short headline for the listing card."),
  houseOverview: z.string().optional().describe("2–4 sentence description of the home."),
  amenitiesText: z.string().optional().describe("Amenities, one per line or comma-separated."),
  petFriendly: z.boolean().optional().describe("Whether pets are allowed."),
  housePhotoUrls: z
    .array(z.string().min(1))
    .max(24)
    .optional()
    .describe("Public listing-photos URLs from chat uploads or prior tools."),
  placeCategory: z
    .enum(["shared_home", "entire_home"])
    .optional()
    .describe("shared_home = rooms; entire_home = whole unit."),
  unitLabel: z.string().optional().describe("Unit label when relevant, e.g. 'Unit B'."),
  securityDepositUsd: z.number().min(0).optional(),
  applicationFeeUsd: z.number().min(0).optional(),
};

async function loadOwnedDraftSubmission(
  ctx: AgentContext,
  draftId: string,
): Promise<{ submission: ManagerListingSubmissionV1 } | null> {
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("row_data, status")
    .eq("id", draftId.trim())
    .eq("manager_user_id", ctx.landlordId)
    .maybeSingle();
  if (error || !data?.row_data) return null;
  const row = data.row_data as { submission?: unknown };
  const raw = row.submission;
  if (!raw || typeof raw !== "object") return null;
  return { submission: normalizeManagerListingSubmissionV1(raw as ManagerListingSubmissionV1) };
}

function previewFields(input: ListingDraftToolInput) {
  return [
    { label: "Title", value: input.buildingName.trim() },
    { label: "Address", value: input.address.trim() },
    ...(input.neighborhood?.trim() ? [{ label: "Neighborhood", value: input.neighborhood.trim() }] : []),
    { label: "Beds / Baths", value: `${input.beds} bd / ${input.baths} ba` },
    { label: "Rent", value: `$${Math.round(input.monthlyRentUsd)}/mo` },
    ...(input.tagline?.trim() ? [{ label: "Tagline", value: input.tagline.trim() }] : []),
    ...(input.housePhotoUrls?.length
      ? [{ label: "Photos", value: `${input.housePhotoUrls.length} house photo(s)` }]
      : []),
    { label: "Saved as", value: "Draft — finish in Properties or submit for admin review when ready" },
  ];
}

export const getListingCreationChecklistTool = defineTool({
  name: "get_listing_creation_checklist",
  description:
    "Read the step-by-step checklist for building a quality listing through chat: required fields, recommended copy, photo handling, and when to call create_listing_draft.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async () => LISTING_CREATION_CHECKLIST,
});

export const createListingDraftTool = defineWriteTool({
  name: "create_listing_draft",
  description:
    "Create a rich property listing DRAFT from facts gathered in chat (address, rent, beds/baths, description, amenities, and housePhotoUrls from uploaded images). Saves status 'draft' so the manager can review in Properties → Add listing; does not publish live.",
  inputSchema: z.object(listingDraftFields).strict(),
  preview: async (_ctx, input) => {
    if (!input.housePhotoUrls?.length) {
      throw new Error("Add at least one house photo (manager attaches images in chat) before creating the draft.");
    }
    return {
      kind: "create_listing_draft",
      title: "Create listing draft",
      summary: `Save a draft listing for "${input.buildingName.trim()}" at ${input.address.trim()}.`,
      fields: previewFields(input),
      confirmLabel: "Create draft",
    };
  },
  handler: async (ctx, input) => {
    if (!input.housePhotoUrls?.length) {
      throw new Error("At least one house photo URL is required.");
    }
    const dedupeKey = `create_listing_draft:${ctx.landlordId}:${input.address.trim().toLowerCase()}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "create_listing_draft",
      toolName: "create_listing_draft",
      inputSummary: { address: input.address.trim(), buildingName: input.buildingName.trim() },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "A listing draft for this address was already created today." };
      throw new Error("Could not record the action; no draft was saved.");
    }

    const submission = buildListingSubmissionFromDraftInput(input);
    let propertyId: string;
    try {
      ({ propertyId } = await upsertManagerListingDraft(ctx.db, ctx.landlordId, submission));
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { error: "save_failed" }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The draft could not be saved.");
    }

    await updateAuditResult(ctx, dedupeKey, { propertyId });
    return {
      reply: `Saved a draft listing for "${input.buildingName.trim()}" (${propertyId}). Open Properties to review photos, rooms, and submit for publishing when ready.`,
      resultSummary: { propertyId, status: "draft" },
    };
  },
});

const updateListingDraftInputSchema = z
  .object({
    draftPropertyId: z.string().min(1).describe("Draft property id to update."),
    ...listingDraftFields,
  })
  .partial({
    buildingName: true,
    address: true,
    beds: true,
    baths: true,
    monthlyRentUsd: true,
  })
  .strict();

function mergeDraftInput(
  input: z.infer<typeof updateListingDraftInputSchema>,
  loaded: ManagerListingSubmissionV1,
): ListingDraftToolInput {
  const existingRent = loaded.rooms[0]?.monthlyRent ?? 0;
  const existingBaths = Number(loaded.listingTotalBathroomsId) || 1;
  const photoUrls = input.housePhotoUrls?.length
    ? [...new Set([...loaded.housePhotoDataUrls, ...input.housePhotoUrls])]
    : loaded.housePhotoDataUrls;
  return {
    buildingName: input.buildingName ?? loaded.buildingName,
    address: input.address ?? loaded.address,
    zip: input.zip ?? loaded.zip,
    neighborhood: input.neighborhood ?? loaded.neighborhood,
    beds: input.beds ?? loaded.listingBedroomSlots ?? 1,
    baths: input.baths ?? existingBaths,
    monthlyRentUsd: input.monthlyRentUsd ?? existingRent,
    tagline: input.tagline ?? loaded.tagline,
    houseOverview: input.houseOverview ?? loaded.houseOverview,
    amenitiesText: input.amenitiesText ?? loaded.amenitiesText,
    petFriendly: input.petFriendly ?? loaded.petFriendly,
    housePhotoUrls: photoUrls.length ? photoUrls : undefined,
    placeCategory: input.placeCategory,
    unitLabel: input.unitLabel,
    securityDepositUsd: input.securityDepositUsd,
    applicationFeeUsd: input.applicationFeeUsd,
  };
}

export const updateListingDraftTool = defineWriteTool({
  name: "update_listing_draft",
  description:
    "Update an existing listing draft (status draft) with more photos, copy, or pricing from chat. Pass draftPropertyId from a prior create_listing_draft or list_properties.",
  inputSchema: updateListingDraftInputSchema,
  preview: async (ctx, input) => {
    const loaded = await loadOwnedDraftSubmission(ctx, input.draftPropertyId);
    if (!loaded) throw new Error("No draft listing with that id was found for this account.");

    const merged = mergeDraftInput(input, loaded.submission);
    if (!merged.monthlyRentUsd || merged.monthlyRentUsd <= 0) {
      throw new Error("monthlyRentUsd is required when the draft has no rent set yet.");
    }

    return {
      kind: "update_listing_draft",
      title: "Update listing draft",
      summary: `Update draft "${merged.buildingName}" (${input.draftPropertyId}).`,
      fields: previewFields(merged),
      confirmLabel: "Update draft",
    };
  },
  handler: async (ctx, input) => {
    const loaded = await loadOwnedDraftSubmission(ctx, input.draftPropertyId);
    if (!loaded) throw new Error("No draft listing with that id was found.");

    const merged = mergeDraftInput(input, loaded.submission);

    const submission = buildListingSubmissionFromDraftInput(merged, loaded.submission);
    const dedupeKey = `update_listing_draft:${ctx.landlordId}:${input.draftPropertyId}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_listing_draft",
      toolName: "update_listing_draft",
      inputSummary: { draftPropertyId: input.draftPropertyId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That draft update was already applied today." };
      throw new Error("Could not record the action.");
    }

    try {
      await upsertManagerListingDraft(ctx.db, ctx.landlordId, submission, input.draftPropertyId);
    } catch (e) {
      await updateAuditResult(ctx, dedupeKey, { error: "save_failed" }, { clearDedupeKey: true });
      throw new Error(e instanceof Error ? e.message : "The draft could not be updated.");
    }

    await updateAuditResult(ctx, dedupeKey, { draftPropertyId: input.draftPropertyId });
    return {
      reply: `Updated the draft listing "${submission.buildingName}". Continue in Properties when ready to publish.`,
      resultSummary: { propertyId: input.draftPropertyId },
    };
  },
});

/**
 * The guided create-a-listing-by-text flow's one write (design-1112 section 3.3): address, room count, rent and an
 * optional detail become a DRAFT. `status: "draft"` on the ordinary record, never public and never a plan slot; photos
 * arrive later by MMS and publishing stays a portal action. The id is deterministic per (owner, flow), so a retried
 * confirmation updates the same row instead of making a second draft. Unlike `create_listing_draft` it needs no photo.
 */
export const createListingDraftByTextTool = defineWriteTool({
  name: "create_listing_draft_by_text",
  description:
    "Save a listing DRAFT from facts a manager texted step by step: street address, number of rooms and the rent (one amount for every room, or one per room). Never publishes. Photos are added afterwards.",
  inputSchema: z
    .object({
      flowId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).describe("Opaque id of the text conversation; makes a retry idempotent."),
      address: z.string().trim().min(3).max(200).describe("Street address."),
      roomCount: z.number().int().min(1).max(20).describe("Number of rentable rooms."),
      rentsUsd: z.array(z.number().positive().max(100000)).min(1).max(20).describe("One monthly rent for every room, or one per room."),
      details: z.string().trim().max(1200).optional().describe("A line of description for the listing."),
    })
    .strict()
    .refine((v) => v.rentsUsd.length === 1 || v.rentsUsd.length === v.roomCount, { message: "Give one rent, or one rent per room." }),
  preview: async (_ctx, input) => ({
    kind: "create_listing_draft_by_text",
    title: "Save listing draft",
    summary: `Save a draft for ${input.address}.`,
    fields: [
      { label: "Address", value: input.address },
      { label: "Rooms", value: String(input.roomCount) },
      {
        label: "Rent",
        value: input.rentsUsd.length === 1
          ? `$${Math.round(input.rentsUsd[0]!)}/mo each`
          : input.rentsUsd.map((r, i) => `Room ${i + 1} $${Math.round(r)}`).join(", "),
      },
      ...(input.details ? [{ label: "Details", value: input.details }] : []),
      { label: "Saved as", value: "Draft, not public" },
    ],
    confirmLabel: "Save draft",
  }),
  handler: async (ctx, input) => {
    const propertyId = draftIdFor(ctx.landlordId, input.flowId);
    const dedupeKey = `create_listing_draft_by_text:${ctx.landlordId}:${input.flowId}`;
    const audit = await writeAuditLog(ctx, {
      action: "create_listing_draft_by_text",
      toolName: "create_listing_draft_by_text",
      inputSummary: { roomCount: input.roomCount },
      dedupeKey,
    });
    if (!audit.recorded && !audit.duplicate) throw new Error("Could not record the action; no draft was saved.");
    const roomCount = input.roomCount;
    const rentFor = (index: number) => Math.round(input.rentsUsd.length === 1 ? input.rentsUsd[0]! : input.rentsUsd[index]!);
    const submission = submissionFromImportedProperty({
      key: "text-listing",
      name: input.address,
      address: input.address,
      city: "",
      state: "",
      zip: "",
      propertyType: "house",
      rentByRoom: roomCount > 1,
      bedrooms: roomCount,
      bathrooms: null,
      monthlyRent: roomCount > 1 ? null : rentFor(0),
      deposit: null,
      rooms: roomCount > 1 ? Array.from({ length: roomCount }, (_, i) => ({ label: `Room ${i + 1}`, rent: rentFor(i), deposit: null, sourceRow: null })) : [],
      sourceSheet: "",
      sourceRows: [],
      needsLook: [],
      confidence: "medium",
    });
    if (input.details) submission.houseOverview = input.details;
    const row = {
      ...submissionToDraftAdminRow(submission, ctx.landlordId, propertyId, {}),
      source: "text_setup" as const,
      importedAt: new Date().toISOString(),
    };
    const { data: existing } = await ctx.db.from("manager_property_records").select("manager_user_id, status").eq("id", propertyId).maybeSingle();
    if (existing && (String(existing.manager_user_id) !== ctx.landlordId || existing.status !== "draft")) {
      throw new Error("That draft was already changed in PropLane, so I left it alone.");
    }
    const workspaceId = ctx.workspace?.id?.trim();
    const { error } = await ctx.db.from("manager_property_records").upsert(
      {
        id: propertyId,
        manager_user_id: ctx.landlordId,
        status: "draft",
        row_data: row,
        property_data: null,
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "save_failed" }, { clearDedupeKey: true });
      throw new Error(error.message.includes("10 property records") ? "This workspace is at its 10 listing limit, so I could not save another draft." : "The draft could not be saved.");
    }
    await updateAuditResult(ctx, dedupeKey, { propertyId });
    return {
      reply: `Saved a draft for ${input.address}. Finish it under Properties in PropLane. Text photos now to add them.`,
      resultSummary: { propertyId, status: "draft" },
    };
  },
});
