import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isLeaseAssistantContext } from "@/lib/agent/assistant-turn-context";
import { deriveLegacyFields } from "@/lib/demo-property-pipeline";
import {
  applyListingBathroomSlots,
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  LEASE_TEMPLATE_BUCKET,
  LEASE_TEMPLATE_MAX_BYTES,
  leaseTemplateUrlForPath,
} from "@/lib/lease-template-storage";
import { listingMediaObjectPath } from "@/lib/listing-media-storage";

function slugPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function mintListingDraftId(legacy: { buildingName: string; unitLabel: string }): string {
  const suffix = `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 8)}`;
  const nameSlug = slugPart(legacy.buildingName);
  return nameSlug ? `mgr-${nameSlug}-${slugPart(legacy.unitLabel)}-${suffix}` : `mgr-listing-${suffix}`;
}

export async function uploadListingPhotoBytes(
  db: SupabaseClient,
  managerUserId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  const path = `${managerUserId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await db.storage.from("listing-photos").upload(path, bytes, {
    contentType: mime,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return db.storage.from("listing-photos").getPublicUrl(path).data.publicUrl;
}

export function imageBlocksFromUserMessage(message: Anthropic.MessageParam): Anthropic.ImageBlockParam[] {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.filter((block): block is Anthropic.ImageBlockParam => block.type === "image");
}

export function documentBlocksFromUserMessage(
  message: Anthropic.MessageParam,
): Anthropic.DocumentBlockParam[] {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return [];
  return message.content.filter((block): block is Anthropic.DocumentBlockParam => block.type === "document");
}

export async function uploadLeaseTemplateBytes(
  db: SupabaseClient,
  managerUserId: string,
  bytes: Buffer,
): Promise<string> {
  if (bytes.length === 0 || bytes.length > LEASE_TEMPLATE_MAX_BYTES) {
    throw new Error("Lease template PDF is empty or too large.");
  }
  const path = `${managerUserId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  const { error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    cacheControl: "0",
    upsert: false,
  });
  if (error) throw new Error(error.message);
  return leaseTemplateUrlForPath(path);
}

export async function persistListingPhotoUrlsFromImageBlocks(
  db: SupabaseClient,
  managerUserId: string,
  blocks: Anthropic.ImageBlockParam[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const block of blocks) {
    if (block.source.type !== "base64") continue;
    const bytes = Buffer.from(block.source.data, "base64");
    const url = await uploadListingPhotoBytes(db, managerUserId, bytes, block.source.media_type);
    urls.push(url);
  }
  return urls;
}

/** Append durable listing-photo URLs so the model can pass them into create_listing_draft. */
export function appendListingPhotoUrlsToUserMessage(
  message: Anthropic.MessageParam,
  urls: string[],
): Anthropic.MessageParam {
  return appendUploadedImageUrlsToUserMessage(message, urls, "listing");
}

export type ChatImageUploadPurpose = "listing" | "promotion";

/** Annotate the last user turn with durable image URLs for tool calls. */
export function appendUploadedImageUrlsToUserMessage(
  message: Anthropic.MessageParam,
  urls: string[],
  purpose: ChatImageUploadPurpose,
  contextHint?: string | null,
): Anthropic.MessageParam {
  if (!urls.length || !Array.isArray(message.content)) return message;
  const hint = contextHint?.trim() ?? "";
  const listingModalOpen =
    purpose === "listing" && /edit listing|new listing|listing ·/i.test(hint);
  const note =
    purpose === "promotion"
      ? [
          "Reference flyer image(s) for style matching. When proposing create_promotion or generate_promotion_flyer, pass these exact URLs in referenceImageUrls and describe layout, colors, and typography in notes or extraInstructions:",
          ...urls.map((url, index) => `${index + 1}. ${url}`),
        ].join("\n")
      : listingModalOpen
        ? [
            "Uploaded listing photos. Visually classify each image, then propose apply_listing_photos with propertyId from context and the correct target (house, room, bathroom, or shared_space) plus targetId when needed. URLs:",
            ...urls.map((url, index) => `${index + 1}. ${url}`),
          ].join("\n")
        : [
            "Uploaded listing photos (use these exact URLs in housePhotoUrls for create_listing_draft or update_listing_draft):",
            ...urls.map((url, index) => `${index + 1}. ${url}`),
          ].join("\n");
  return {
    role: "user",
    content: [...message.content, { type: "text", text: note }],
  };
}

export type ListingDraftToolInput = {
  buildingName: string;
  address: string;
  zip?: string;
  neighborhood?: string;
  beds: number;
  baths: number;
  monthlyRentUsd: number;
  tagline?: string;
  houseOverview?: string;
  amenitiesText?: string;
  petFriendly?: boolean;
  housePhotoUrls?: string[];
  placeCategory?: "shared_home" | "entire_home";
  unitLabel?: string;
  securityDepositUsd?: number;
  applicationFeeUsd?: number;
};

function normalizePhotoUrls(urls: string[] | undefined): string[] {
  if (!urls?.length) return [];
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;
    if (url.startsWith("data:")) continue;
    if (!listingMediaObjectPath(url) && !url.includes("/listing-photos/")) continue;
    out.push(url);
  }
  return [...new Set(out)];
}

export function buildListingSubmissionFromDraftInput(
  input: ListingDraftToolInput,
  existing?: ManagerListingSubmissionV1 | null,
): ManagerListingSubmissionV1 {
  const base = existing ? normalizeManagerListingSubmissionV1(existing) : createDefaultListingSubmission();
  const beds = Math.max(1, Math.round(input.beds));
  const baths = Math.max(0, input.baths);
  const rent = Math.max(0, Math.round(input.monthlyRentUsd));

  base.buildingName = input.buildingName.trim();
  base.address = input.address.trim();
  base.zip = input.zip?.trim() ?? base.zip;
  base.neighborhood = input.neighborhood?.trim() ?? base.neighborhood;
  base.listingPlaceCategoryId = input.placeCategory ?? (base.listingPlaceCategoryId || "shared_home");
  base.listingBedroomSlots = beds;
  base.listingTotalBathroomsId = String(Math.round(baths));
  base.petFriendly = input.petFriendly === true;
  base.tagline = input.tagline?.trim() || input.houseOverview?.trim().slice(0, 160) || base.tagline || "New listing";
  if (input.houseOverview?.trim()) base.houseOverview = input.houseOverview.trim();
  if (input.amenitiesText?.trim()) base.amenitiesText = input.amenitiesText.trim();

  const photos = normalizePhotoUrls(input.housePhotoUrls);
  if (photos.length) {
    base.housePhotoDataUrls = [...new Set([...base.housePhotoDataUrls, ...photos])];
  }

  if (input.securityDepositUsd != null && Number.isFinite(input.securityDepositUsd)) {
    base.securityDeposit = `$${Math.round(input.securityDepositUsd)}.00`;
  }
  if (input.applicationFeeUsd != null && Number.isFinite(input.applicationFeeUsd)) {
    base.applicationFee = `$${Math.round(input.applicationFeeUsd)}.00`;
  }

  if (!base.rooms.length) base.rooms = [emptyRoom(0)];
  const firstRoom = { ...base.rooms[0]! };
  firstRoom.monthlyRent = rent;
  if (!firstRoom.name.trim()) firstRoom.name = input.placeCategory === "entire_home" ? "Entire home" : "Room 1";
  base.rooms = [firstRoom, ...base.rooms.slice(1)];

  const withBaths = applyListingBathroomSlots(base);
  return normalizeManagerListingSubmissionV1(withBaths.ok ? withBaths.sub : base);
}

export async function upsertManagerListingDraft(
  db: SupabaseClient,
  managerUserId: string,
  submission: ManagerListingSubmissionV1,
  existingDraftId?: string | null,
): Promise<{ propertyId: string }> {
  const normalized = normalizeManagerListingSubmissionV1(submission);
  const legacy = deriveLegacyFields(normalized);
  const propertyId = existingDraftId?.trim() || mintListingDraftId(legacy);
  const rowData = {
    id: propertyId,
    submittedAt: new Date().toISOString(),
    submittedByUserId: managerUserId,
    submission: normalized,
    ...legacy,
  };

  const { data: existing } = await db
    .from("manager_property_records")
    .select("manager_user_id, status")
    .eq("id", propertyId)
    .maybeSingle();
  if (existing && String(existing.manager_user_id) !== managerUserId) {
    throw new Error("That listing draft belongs to another account.");
  }
  if (existing && existing.status !== "draft" && existing.status !== "pending") {
    throw new Error("Only draft or pending listings can be updated this way.");
  }

  // No plan-quota gate: this always writes status "draft", which is never a
  // listing slot (LISTING_SLOT_PROPERTY_STATUSES), so it can only ever free a
  // slot — a pending row demoted back to draft — never occupy one. Publishing
  // the draft goes through `POST /api/property-records`, where the cap runs.
  const { error } = await db.from("manager_property_records").upsert(
    {
      id: propertyId,
      manager_user_id: managerUserId,
      status: "draft",
      row_data: rowData,
      property_data: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
  return { propertyId };
}

/** Persist chat image blocks to listing-photos and annotate the last user turn for the model. */
export async function enrichMessagesWithUploadedListingPhotos(
  db: SupabaseClient,
  managerUserId: string,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  return enrichManagerChatImageAttachments(db, managerUserId, messages, {
    requireSuccessfulUpload: true,
    purpose: "listing",
  });
}

/**
 * Upload chat images when possible and annotate the turn. Listing-draft flows
 * require a durable URL; promotion and other surfaces keep inline vision blocks
 * when upload fails so the turn still succeeds.
 */
export async function enrichManagerChatImageAttachments(
  db: SupabaseClient,
  managerUserId: string,
  messages: Anthropic.MessageParam[],
  opts: { requireSuccessfulUpload: boolean; purpose: ChatImageUploadPurpose; contextHint?: string | null },
): Promise<Anthropic.MessageParam[]> {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1]!;
  const blocks = imageBlocksFromUserMessage(last);
  if (!blocks.length) return messages;
  let urls: string[] = [];
  try {
    urls = await persistListingPhotoUrlsFromImageBlocks(db, managerUserId, blocks);
  } catch (e) {
    if (opts.requireSuccessfulUpload) throw e;
    console.warn("[agent/chat] optional image upload failed:", e);
  }
  if (opts.requireSuccessfulUpload && blocks.length > 0 && urls.length === 0) {
    throw new Error("Could not upload attached photos.");
  }
  const next = [...messages];
  if (urls.length > 0) {
    next[next.length - 1] = appendUploadedImageUrlsToUserMessage(last, urls, opts.purpose, opts.contextHint);
    return next;
  }
  if (opts.purpose === "promotion" && blocks.length > 0) {
    next[next.length - 1] = appendPromotionVisionFallbackNote(last);
  }
  return next;
}

/** Upload lease-template PDFs from chat and annotate the turn with durable URLs. */
export async function enrichManagerChatDocumentAttachments(
  db: SupabaseClient,
  managerUserId: string,
  messages: Anthropic.MessageParam[],
  contextHint?: string | null,
): Promise<Anthropic.MessageParam[]> {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1]!;
  const blocks = documentBlocksFromUserMessage(last);
  if (!blocks.length) return messages;
  const hint = contextHint?.trim() ?? "";
  if (!isLeaseAssistantContext(hint)) return messages;

  const urls: string[] = [];
  for (const block of blocks) {
    if (block.source.type !== "base64") continue;
    const bytes = Buffer.from(block.source.data, "base64");
    urls.push(await uploadLeaseTemplateBytes(db, managerUserId, bytes));
  }
  if (!urls.length) return messages;

  const next = [...messages];
  next[next.length - 1] = {
    role: "user",
    content: [
      ...(Array.isArray(last.content) ? last.content : []),
      {
        type: "text",
        text: [
          "Uploaded lease template PDF(s). When proposing update_property_lease_config with custom_format, pass this exact leaseTemplateDocUrl:",
          ...urls.map((url, index) => `${index + 1}. ${url}`),
        ].join("\n"),
      },
    ],
  };
  return next;
}

/** When storage upload fails, keep inline vision blocks and tell the model how to proceed. */
function appendPromotionVisionFallbackNote(message: Anthropic.MessageParam): Anthropic.MessageParam {
  if (!Array.isArray(message.content)) return message;
  return {
    role: "user",
    content: [
      ...message.content,
      {
        type: "text",
        text:
          "Reference flyer image is attached above for visual style. Describe layout, colors, and typography in notes or extraInstructions when proposing create_promotion or generate_promotion_flyer. referenceImageUrls is optional on this turn when the image is visible here.",
      },
    ],
  };
}

export const LISTING_CREATION_CHECKLIST = {
  requiredBeforeCreate: [
    "Property name or building title",
    "Street address (and ZIP when known)",
    "Bedrooms and bathrooms",
    "Monthly rent",
    "At least one house photo (attach with the paperclip — URLs are uploaded automatically)",
  ],
  recommendedForQuality: [
    "Neighborhood label",
    "Short tagline and 2–3 sentence overview",
    "Amenities (one per line: laundry, parking, Wi‑Fi, etc.)",
    "Pet policy",
    "Security deposit and application fee",
  ],
  workflow:
    "Ask one or two questions at a time. When the manager attaches photos, use the uploaded URLs from the message. When enough fields are gathered, propose create_listing_draft once — they confirm before the draft is saved. They can finish or publish from Properties → Add listing.",
};
