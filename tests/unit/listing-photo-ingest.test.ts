import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makeCommandDb } from "../helpers/command-fake-db";
import { deriveListingJpeg, ingestListingPhoto, isHeicType, looksLikeHeic } from "@/lib/listing-photo-ingest.server";
import type { SmsMediaFileRow } from "@/lib/one-number/inbound-media.server";

const HEIC = readFileSync(path.join(__dirname, "../fixtures/heic/room-640x480.heic"));

async function jpeg(width: number, height: number, opts: { orientation?: number } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, 140);
  let pipeline = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.orientation) pipeline = pipeline.withMetadata({ orientation: opts.orientation });
  return pipeline.jpeg({ quality: 80 }).toBuffer();
}

function mediaRow(over: Partial<SmsMediaFileRow> = {}): SmsMediaFileRow {
  return {
    id: "m1", message_sid: "SM123", media_index: 0, workspace_id: "ws-1", sender_phone_key: "2065550100",
    storage_path: "manager/owner-1/SM123/0.jpg", content_type: "image/jpeg", byte_size: 1000, linked_type: null, linked_id: null,
    created_at: new Date().toISOString(), ...over,
  };
}

describe("listing photo derivative", () => {
  it("decodes a real HEIC file to JPEG (sharp alone cannot)", async () => {
    expect(looksLikeHeic(HEIC)).toBe(true);
    expect(isHeicType("image/heic")).toBe(true);
    // the premise of the dependency: the prebuilt libvips has no HEVC decoder
    await expect(sharp(HEIC).jpeg().toBuffer()).rejects.toThrow();
    const out = await deriveListingJpeg(HEIC, "image/heic");
    expect(out.convertedFromHeic).toBe(true);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([640, 480]);
  });

  it("decodes a HEIC that the carrier labelled as something else", async () => {
    const out = await deriveListingJpeg(HEIC, "image/jpeg");
    expect(out.convertedFromHeic).toBe(true);
  });

  it("applies EXIF orientation and drops the metadata", async () => {
    const source = await jpeg(600, 400, { orientation: 6 });
    expect((await sharp(source).metadata()).orientation).toBe(6);
    const out = await deriveListingJpeg(source, "image/jpeg");
    expect([out.width, out.height]).toEqual([400, 600]);
    expect((await sharp(out.buffer).metadata()).orientation).toBeUndefined();
  });

  it("caps a 12 MP photo at 2560 px on the long edge and never upscales", async () => {
    const big = await deriveListingJpeg(await jpeg(4032, 3024), "image/jpeg");
    expect(Math.max(big.width, big.height)).toBe(2560);
    expect(big.height).toBe(1920);
    const small = await deriveListingJpeg(await jpeg(800, 600), "image/jpeg");
    expect([small.width, small.height]).toEqual([800, 600]);
    const exact = await deriveListingJpeg(await jpeg(2000, 1500), "image/jpeg");
    expect([exact.width, exact.height]).toEqual([2000, 1500]);
  });

  it("refuses what is not an image", async () => {
    await expect(deriveListingJpeg(Buffer.from("%PDF-1.4"), "application/pdf")).rejects.toThrow("unsupported_image_type");
  });
});

describe("ingestListingPhoto", () => {
  it("keeps the original untouched in sms-media and files a JPEG derivative in listing-photos", async () => {
    const db = makeCommandDb();
    const original = HEIC;
    await db.storage.from("sms-media").upload("manager/owner-1/SM123/0.heic", original, { contentType: "image/heic" });
    const result = await ingestListingPhoto(db as never, {
      ownerUserId: "owner-1", propertyId: "prop-1", mediaRow: mediaRow({ storage_path: "manager/owner-1/SM123/0.heic", content_type: "image/heic" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.originalPath).toBe("manager/owner-1/SM123/0.heic");
    expect(result.publicUrl).toContain("/listing-photos/owner-1/prop-1/sms-SM123-0.jpg");
    expect(Buffer.compare(db.bucket("sms-media").get("manager/owner-1/SM123/0.heic")!.bytes, original)).toBe(0);
    const derived = db.bucket("listing-photos").get("owner-1/prop-1/sms-SM123-0.jpg")!;
    expect(derived.contentType).toBe("image/jpeg");
    expect((await sharp(derived.bytes).metadata()).format).toBe("jpeg");
  });

  it("flags a small source but still files it", async () => {
    const db = makeCommandDb();
    await db.storage.from("sms-media").upload("manager/owner-1/SM9/0.jpg", await jpeg(800, 600), { contentType: "image/jpeg" });
    const result = await ingestListingPhoto(db as never, {
      ownerUserId: "owner-1", propertyId: "prop-1", mediaRow: mediaRow({ message_sid: "SM9", storage_path: "manager/owner-1/SM9/0.jpg" }),
    });
    expect(result).toMatchObject({ ok: true, small: true, sourceLongEdge: 800, width: 800 });
  });

  it("will not read another owner's media", async () => {
    const db = makeCommandDb();
    await db.storage.from("sms-media").upload("manager/someone-else/SM1/0.jpg", await jpeg(100, 100), { contentType: "image/jpeg" });
    const result = await ingestListingPhoto(db as never, {
      ownerUserId: "owner-1", propertyId: "prop-1", mediaRow: mediaRow({ storage_path: "manager/someone-else/SM1/0.jpg" }),
    });
    expect(result).toEqual({ ok: false, reason: "not_owner_media" });
  });

  it("a PropLane line text is stored under the line owner but filed under the property owner", async () => {
    const db = makeCommandDb();
    await db.storage.from("sms-media").upload("manager/line-owner/SM2/0.jpg", await jpeg(1600, 1200), { contentType: "image/jpeg" });
    const result = await ingestListingPhoto(db as never, {
      ownerUserId: "client-owner", mediaOwnerUserId: "line-owner", propertyId: "prop-1",
      mediaRow: mediaRow({ message_sid: "SM2", storage_path: "manager/line-owner/SM2/0.jpg" }),
    });
    expect(result.ok).toBe(true);
    expect(db.bucket("listing-photos").has("client-owner/prop-1/sms-SM2-0.jpg")).toBe(true);
  });
});
