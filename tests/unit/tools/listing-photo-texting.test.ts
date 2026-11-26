import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifiedPhoneOfActor: vi.fn(),
  loadSenderRecentImages: vi.fn(),
  loadSuggestionFiles: vi.fn(),
  recordListingPhotoSuggestion: vi.fn(),
  ingestListingPhoto: vi.fn(),
  linkClaimedMedia: vi.fn(),
}));

vi.mock("@/lib/listing-photo-suggestions.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/listing-photo-suggestions.server")>()),
  verifiedPhoneOfActor: mocks.verifiedPhoneOfActor,
  loadSenderRecentImages: mocks.loadSenderRecentImages,
  loadSuggestionFiles: mocks.loadSuggestionFiles,
  recordListingPhotoSuggestion: mocks.recordListingPhotoSuggestion,
}));
vi.mock("@/lib/listing-photo-ingest.server", () => ({ ingestListingPhoto: mocks.ingestListingPhoto }));
vi.mock("@/lib/one-number/inbound-media.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one-number/inbound-media.server")>()),
  linkClaimedMedia: mocks.linkClaimedMedia,
}));

import { placeMyTextedPhotosTool, placeResidentSuggestedPhotosTool } from "@/lib/tools/domains/listing-media";
import { suggestListingPhotosTool } from "@/lib/tools/domains/resident/listing-photo-suggestion";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import { executeWrite, makeWritableCtx, previewWrite } from "./fake-agent-ctx";

const MANAGER = "manager_a";
const PROPERTY = "mgr-seed-5257-brooklyn";

function listing() {
  const submission = {
    v: 1,
    buildingName: "5257 Brooklyn Ave NE",
    address: "5257 Brooklyn Ave NE, Seattle, WA",
    housePhotoDataUrls: [],
    rooms: [{ id: "room-7", name: "Room 7", photoDataUrls: [] }],
    bathrooms: [],
    sharedSpaces: [{ id: "kitchen", name: "Kitchen", photoDataUrls: [] }],
  };
  return { id: PROPERTY, manager_user_id: MANAGER, status: "live", row_data: { submission }, property_data: { buildingName: "5257 Brooklyn Ave NE", listingSubmission: submission } };
}

const fileRow = (id: string) => ({ id, message_sid: `SM${id}`, media_index: 0, storage_path: `manager/${MANAGER}/SM${id}-0.jpg`, content_type: "image/jpeg" });

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.ingestListingPhoto.mockImplementation(async (_db, input) => ({
    ok: true,
    publicUrl: `https://cdn.test/listing-photos/${input.mediaRow.id}.jpg`,
    originalPath: input.mediaRow.storage_path,
    width: 3000,
    height: 2000,
    small: false,
    sourceLongEdge: 3000,
  }));
});

describe("place_my_texted_photos (manager / staff by text)", () => {
  it("is on the manager SMS registry and the delegated-listing allow list, never a model-supplied URL", () => {
    expect(buildManagerSmsRegistry().has("place_my_texted_photos")).toBe(true);
    expect(buildManagerSmsRegistry().has("place_resident_suggested_photos")).toBe(true);
    expect(agentRegistry.has("place_my_texted_photos")).toBe(true);
    expect(placeMyTextedPhotosTool.inputSchema.safeParse({ propertyId: PROPERTY, photoUrl: "https://evil.test/x.jpg" }).success).toBe(false);
    expect(placeMyTextedPhotosTool.inputSchema.safeParse({ propertyId: PROPERTY, target: "room", targetId: "room-7" }).success).toBe(true);
  });

  it("previews 'Add 2 photos to 5257 Brooklyn Ave NE · Room 7' from the sender's own media", async () => {
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a"), fileRow("b")]);
    const { ctx } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    const preview = await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY, target: "room", targetId: "room-7" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.summary).toBe("Add 2 photos to 5257 Brooklyn Ave NE · Room 7.");
    // Media came from the actor's verified phone, not from the input.
    expect(mocks.verifiedPhoneOfActor).toHaveBeenCalledWith(ctx.db, ctx.userId);
    expect(mocks.loadSenderRecentImages).toHaveBeenCalledWith(ctx.db, { senderPhoneE164: "+12065550101" });
  });

  it("refuses with no verified phone, no recent photos, an unknown room, or a listing outside the account", async () => {
    const { ctx } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    mocks.verifiedPhoneOfActor.mockResolvedValue(null);
    expect((await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY })).ok).toBe(false);
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([]);
    expect((await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY })).ok).toBe(false);
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a")]);
    expect((await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY, target: "room", targetId: "room-99" })).ok).toBe(false);
    expect((await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: "someone-elses" })).ok).toBe(false);
  });

  /** Preview, then confirm with what the gate STORED - the real sequence behind a YES. */
  async function previewThenConfirm(ctx: unknown, input: Record<string, unknown>) {
    const preview = await previewWrite(placeMyTextedPhotosTool, ctx, input);
    if (!preview.ok) return { preview, result: { ok: false as const, error: preview.error } };
    return { preview, result: await executeWrite(placeMyTextedPhotosTool, ctx, preview.input) };
  }

  it("confirm ingests to the public bucket, places into the named room, and claims the photos", async () => {
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a"), fileRow("b")]);
    const { ctx, store } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    const { result } = await previewThenConfirm(ctx, { propertyId: PROPERTY, target: "room", targetId: "room-7" });
    expect(result.ok).toBe(true);
    expect(mocks.ingestListingPhoto).toHaveBeenCalledTimes(2);
    const sub = (store.manager_property_records![0]!.property_data as { listingSubmission: { rooms: Array<{ photoDataUrls: string[] }> } }).listingSubmission;
    expect(sub.rooms[0]!.photoDataUrls).toEqual(["https://cdn.test/listing-photos/a.jpg", "https://cdn.test/listing-photos/b.jpg"]);
    expect(mocks.linkClaimedMedia).toHaveBeenCalledWith(ctx.db, { ids: ["a", "b"], linkedType: "listing", linkedId: `${PROPERTY}:room-7` });
  });

  // The confirm gate replays the STORED input, and "the photos from the last half hour" is a different set by the time
  // YES comes back (`WritePreview.confirmedInput` exists for exactly this drift). What the card counted is what is
  // placed: the two bathroom photos texted after the preview are not added to Room 7 behind the manager's back.
  it("places only the photos the card counted, even when more arrive before YES", async () => {
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a"), fileRow("b"), fileRow("c")]);
    const { ctx, store } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    const preview = await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY, target: "room", targetId: "room-7" });
    expect(preview.ok && preview.preview.summary).toBe("Add 3 photos to 5257 Brooklyn Ave NE · Room 7.");
    if (!preview.ok) return;

    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a"), fileRow("b"), fileRow("c"), fileRow("d"), fileRow("e")]);
    const result = await executeWrite(placeMyTextedPhotosTool, ctx, preview.input);
    expect(result.ok).toBe(true);
    const sub = (store.manager_property_records![0]!.property_data as { listingSubmission: { rooms: Array<{ photoDataUrls: string[] }> } }).listingSubmission;
    expect(sub.rooms[0]!.photoDataUrls).toEqual([
      "https://cdn.test/listing-photos/a.jpg",
      "https://cdn.test/listing-photos/b.jpg",
      "https://cdn.test/listing-photos/c.jpg",
    ]);
    expect(mocks.linkClaimedMedia).toHaveBeenCalledWith(ctx.db, { ids: ["a", "b", "c"], linkedType: "listing", linkedId: `${PROPERTY}:room-7` });
    expect(result.reply).toMatch(/2 more photos arrived/);
  });

  it("refuses a confirm that names no reviewed photos, or whose photos are no longer waiting", async () => {
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a")]);
    const { ctx } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    expect(await executeWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY })).toMatchObject({ ok: false });
    // The reviewed photo was linked (or the half hour lapsed) before YES: nothing newer is placed in its stead.
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("z")]);
    const result = await executeWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY, mediaIds: ["a"] });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.ingestListingPhoto).not.toHaveBeenCalled();
  });

  it("a shared space (kitchen) is placeable, which the plain MMS filer cannot do", async () => {
    mocks.verifiedPhoneOfActor.mockResolvedValue("+12065550101");
    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a")]);
    const { ctx } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    const preview = await previewWrite(placeMyTextedPhotosTool, ctx, { propertyId: PROPERTY, target: "shared_space", targetId: "kitchen" });
    expect(preview.ok && preview.preview.summary).toBe("Add 1 photo to 5257 Brooklyn Ave NE · Kitchen.");
  });
});

describe("place_resident_suggested_photos", () => {
  it("places a stored suggestion only (found by id under the manager's path) and re-tags it to the listing", async () => {
    mocks.loadSuggestionFiles.mockResolvedValue([fileRow("a")]);
    const { ctx, store } = makeWritableCtx({ manager_property_records: [listing()], audit_log: [] });
    const result = await executeWrite(placeResidentSuggestedPhotosTool, ctx, { suggestionId: "abc123def0", propertyId: PROPERTY });
    expect(result.ok).toBe(true);
    expect(mocks.loadSuggestionFiles).toHaveBeenCalledWith(ctx.db, { managerUserId: MANAGER, suggestionId: "abc123def0" });
    const sub = (store.manager_property_records![0]!.property_data as { listingSubmission: { housePhotoDataUrls: string[] } }).listingSubmission;
    expect(sub.housePhotoDataUrls).toEqual(["https://cdn.test/listing-photos/a.jpg"]);
  });
});

describe("suggest_listing_photos (resident): never writes the listing", () => {
  const residentOverrides = {
    userId: "res_1",
    landlordId: "res_1",
    channel: "sms",
    smsSenderPhoneE164: "+12065550101",
    managerIds: [MANAGER],
    activeManagerId: MANAGER,
  } as never;

  it("is offered to a texting resident only, and previews/sends without any listing read or write", async () => {
    expect(buildResidentRegistry({ ...residentOverrides, phase: "resident", managerTier: "pro" } as never).has("suggest_listing_photos")).toBe(true);
    expect(buildResidentRegistry({ ...residentOverrides, channel: "portal", phase: "resident", managerTier: "pro" } as never).has("suggest_listing_photos")).toBe(false);

    mocks.loadSenderRecentImages.mockResolvedValue([fileRow("a"), fileRow("b")]);
    mocks.recordListingPhotoSuggestion.mockResolvedValue({ ok: true, count: 2, suggestionId: "abc123def0", notified: true });
    const listingRow = listing();
    const { ctx, store } = makeWritableCtx({ manager_property_records: [listingRow], audit_log: [], profiles: [{ id: "res_1", full_name: "Sam" }] }, residentOverrides);

    const preview = await previewWrite(suggestListingPhotosTool, ctx, { note: "5257, my room" });
    expect(preview.ok && preview.preview.summary).toBe("Send 2 photos to your manager to review for the listing.");

    const before = JSON.stringify(store.manager_property_records);
    const sent = await executeWrite(suggestListingPhotosTool, ctx, { note: "5257, my room" });
    expect(sent.ok).toBe(true);
    expect(sent.reply).toMatch(/sent these to your manager to review/i);
    expect(JSON.stringify(store.manager_property_records)).toBe(before);
    expect(mocks.ingestListingPhoto).not.toHaveBeenCalled();
    expect(mocks.recordListingPhotoSuggestion.mock.calls[0]![1]).toMatchObject({ managerUserId: MANAGER, residentUserId: "res_1", senderPhoneE164: "+12065550101" });
  });

  it("refuses off SMS (no phone-bound photos on the portal)", async () => {
    const { ctx } = makeWritableCtx({ audit_log: [] }, { ...residentOverrides, channel: "portal", smsSenderPhoneE164: undefined } as never);
    expect((await previewWrite(suggestListingPhotosTool, ctx, {})).ok).toBe(false);
  });
});
