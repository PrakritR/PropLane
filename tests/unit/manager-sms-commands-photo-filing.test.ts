import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { ingestListingPhoto } from "@/lib/listing-photo-ingest.server";
import { ASK_WHICH_HOUSE, filePhotos, type PhotoFilingDeps } from "@/lib/manager-sms-commands/photo-filing.server";
import { HEIC, STAFF, STAFF_PHONE, WS, housePhotos, jpegBytes, roomPhotos, world } from "../helpers/manager-commands-world";

const KEY = "2065550142";
let w: ReturnType<typeof world>;
let deps: PhotoFilingDeps;

async function sendPhotos(sid: string, files: Array<{ bytes: Buffer; type: string; ext: string }>) {
  for (const [index, file] of files.entries()) {
    const storagePath = `manager/owner-1/${sid}/${index}.${file.ext}`;
    await w.db.storage.from("sms-media").upload(storagePath, file.bytes, { contentType: file.type });
    w.db.tables.sms_media_files ??= [];
    w.db.tables.sms_media_files.push({
      id: `${sid}-${index}`, message_sid: sid, media_index: index, workspace_id: WS, sender_phone_key: KEY,
      storage_path: storagePath, content_type: file.type, byte_size: file.bytes.length, linked_type: null, linked_id: null,
      created_at: new Date().toISOString(),
    });
  }
}

const base = { staffPhoneE164: STAFF_PHONE, actorUserId: STAFF, workspaceIds: [WS], messageSid: "SM-now" };

beforeEach(() => {
  w = world();
  deps = { buildContext: async () => w.ctx, ingest: ingestListingPhoto, now: () => new Date() };
});

describe("photo filing by MMS", () => {
  it("files a HEIC and a JPEG into the named room's gallery and keeps both originals", async () => {
    const jpeg = await jpegBytes(1600, 1200);
    await sendPhotos("SM1", [{ bytes: HEIC, type: "image/heic", ext: "heic" }, { bytes: jpeg, type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "for 5259 room 4", mediaCount: 2 }, w.catalog, deps);
    // the 640 px HEIC fixture is under the 1024 px listing-site floor, so it is filed AND flagged
    expect(result).toEqual({
      handled: true,
      reply: "Added 2 photos to 5259 Brooklyn Ave NE, Room 4. 1 photo is small (640 px) and may be rejected by listing sites.",
    });
    const urls = roomPhotos(w.db, "prop-5259", 3);
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.includes("/listing-photos/owner-1/prop-5259/sms-SM1-"))).toBe(true);
    // the house gallery and the other rooms are untouched
    expect(housePhotos(w.db, "prop-5259")).toHaveLength(0);
    expect(roomPhotos(w.db, "prop-5259", 0)).toHaveLength(0);
    expect(roomPhotos(w.db, "prop-5257", 3)).toHaveLength(0);
    // originals stay private and unchanged; the derivative is a JPEG
    expect(Buffer.compare(w.db.bucket("sms-media").get("manager/owner-1/SM1/0.heic")!.bytes, HEIC)).toBe(0);
    const derived = w.db.bucket("listing-photos").get("owner-1/prop-5259/sms-SM1-0.jpg")!;
    expect((await sharp(derived.bytes).metadata()).format).toBe("jpeg");
    // and the media rows say where they went
    const linked = w.db.tables.sms_media_files!.filter((r) => r.linked_type === "listing");
    expect(linked.map((r) => r.linked_id)).toEqual(["prop-5259:prop-5259-room-4", "prop-5259:prop-5259-room-4"]);
  });

  it("files to the house gallery when no room is named", async () => {
    await sendPhotos("SM2", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "5257", mediaCount: 1 }, w.catalog, deps);
    expect(result).toEqual({ handled: true, reply: "Added 1 photo to 5257 Brooklyn Ave NE." });
    expect(housePhotos(w.db, "prop-5257")).toHaveLength(1);
  });

  it("asks which house when it is unclear, and holds the photos unlinked", async () => {
    await sendPhotos("SM3", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "", mediaCount: 1 }, w.catalog, deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.reply).toContain(ASK_WHICH_HOUSE);
    expect(w.db.tables.sms_media_files!.every((r) => r.linked_type === null)).toBe(true);
    expect(housePhotos(w.db, "prop-5259")).toHaveLength(0);
    expect(w.db.bucket("listing-photos").size).toBe(0);
  });

  it("never guesses between the two Brooklyn houses", async () => {
    await sendPhotos("SM4", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "brooklyn room 2", mediaCount: 1 }, w.catalog, deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.reply).toContain("Which one: 5257 Brooklyn Ave NE or 5259 Brooklyn Ave NE?");
    expect(w.db.tables.sms_media_files!.every((r) => r.linked_type === null)).toBe(true);
  });

  it("files held photos when the manager answers the question, then reuses that house for the next batch", async () => {
    await sendPhotos("SM5", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    await filePhotos(w.db as never, { ...base, body: "", mediaCount: 1 }, w.catalog, deps);
    const answered = await filePhotos(w.db as never, { ...base, messageSid: "SM-answer", body: "5259 room 4", mediaCount: 0 }, w.catalog, deps);
    expect(answered).toEqual({ handled: true, reply: "Added 1 photo to 5259 Brooklyn Ave NE, Room 4." });
    expect(roomPhotos(w.db, "prop-5259", 3)).toHaveLength(1);
    // a second batch with no words at all lands where the last one went, within 15 minutes
    await sendPhotos("SM6", [{ bytes: await jpegBytes(1700, 1200), type: "image/jpeg", ext: "jpg" }]);
    const again = await filePhotos(w.db as never, { ...base, messageSid: "SM6", body: "", mediaCount: 1 }, w.catalog, deps);
    expect(again).toEqual({ handled: true, reply: "Added 1 photo to 5259 Brooklyn Ave NE, Room 4." });
    expect(roomPhotos(w.db, "prop-5259", 3)).toHaveLength(2);
  });

  it("does not reuse a house from more than 15 minutes ago", async () => {
    await sendPhotos("SM7", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    await filePhotos(w.db as never, { ...base, body: "5259", mediaCount: 1 }, w.catalog, deps);
    w.db.tables.sms_media_files![0]!.created_at = new Date(Date.now() - 16 * 60_000).toISOString();
    await sendPhotos("SM8", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, messageSid: "SM8", body: "", mediaCount: 1 }, w.catalog, deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) expect(result.reply).toContain(ASK_WHICH_HOUSE);
  });

  it("files into the house of an open create-a-listing flow once its draft exists", async () => {
    w = world({ sms_listing_flows: [{ staff_phone_key: KEY, workspace_id: WS, step: "confirm", draft: { flowId: "f1", draftPropertyId: "prop-5257" }, property_id: null, expires_at: new Date(Date.now() + 3_600_000).toISOString() }] });
    deps = { ...deps, buildContext: async () => w.ctx };
    await sendPhotos("SM9", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "", mediaCount: 1 }, w.catalog, deps);
    expect(result).toEqual({ handled: true, reply: "Added 1 photo to 5257 Brooklyn Ave NE." });
  });

  it("says when a photo is small, and still files it", async () => {
    await sendPhotos("SM10", [{ bytes: await jpegBytes(800, 600), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "5259 room 1", mediaCount: 1 }, w.catalog, deps);
    expect(result).toMatchObject({ handled: true });
    if (result.handled) {
      expect(result.reply).toContain("Added 1 photo to 5259 Brooklyn Ave NE, Room 1.");
      expect(result.reply).toContain("small (800 px) and may be rejected by listing sites");
    }
    expect(roomPhotos(w.db, "prop-5259", 0)).toHaveLength(1);
  });

  it("a follow-up text that is not about the photos is left to the manager agent", async () => {
    await sendPhotos("SM11", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, messageSid: "SM-x", body: "how is rent collection going this month", mediaCount: 0 }, w.catalog, deps);
    expect(result).toEqual({ handled: false });
    expect(w.db.tables.sms_media_files![0]!.linked_type).toBeNull();
  });

  it("a house outside the workspaces this phone may run is not filed", async () => {
    await sendPhotos("SM12", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, workspaceIds: ["ws-other"], body: "5259", mediaCount: 1 }, w.catalog, deps);
    expect(result).toEqual({ handled: false });
    expect(housePhotos(w.db, "prop-5259")).toHaveLength(0);
  });

  it("an access that cannot add photos gets nothing written", async () => {
    deps = { ...deps, buildContext: async () => null };
    await sendPhotos("SM13", [{ bytes: await jpegBytes(1600, 1200), type: "image/jpeg", ext: "jpg" }]);
    const result = await filePhotos(w.db as never, { ...base, body: "5259", mediaCount: 1 }, w.catalog, deps);
    expect(result).toMatchObject({ handled: true });
    expect(housePhotos(w.db, "prop-5259")).toHaveLength(0);
    expect(w.db.bucket("listing-photos").size).toBe(0);
  });
});
