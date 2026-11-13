import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { LISTING_MEDIA_BUCKET } from "@/lib/listing-media-storage";
import { SMS_MEDIA_BUCKET, SMS_MEDIA_MAX_BYTES } from "@/lib/sms-media.server";
import type { SmsMediaFileRow } from "@/lib/one-number/inbound-media.server";

/**
 * Manager MMS photo -> listing gallery (design-1112 section 4).
 *
 *  - The ORIGINAL bytes stay in the private `sms-media` bucket, untouched (`originalPath`).
 *  - A web derivative is written to the public `listing-photos` bucket: HEIC/HEIF is decoded with `heic-convert`
 *    (sharp's prebuilt libvips has no HEVC decoder), then every image is auto-oriented from EXIF (`rotate()`, which also
 *    drops the metadata, GPS included) and re-encoded as JPEG.
 *  - Never upscaled. The long edge is capped at 2560 px (a 12 MP phone photo is 4032 px) and a smaller source is kept
 *    at its own size, so nothing goes below what a listing platform asks for that the manager did not already send.
 *    A source under `LISTING_PHOTO_MIN_LONG_EDGE` is still filed and flagged so the reply can say so.
 */

export const LISTING_PHOTO_MAX_LONG_EDGE = 2560;
export const LISTING_PHOTO_MIN_LONG_EDGE = 1024;
const JPEG_QUALITY = 88;
const HEIC_INTERMEDIATE_QUALITY = 0.92;
const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const RASTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function isHeicType(contentType: string): boolean {
  return HEIC_TYPES.has(contentType.split(";")[0]!.trim().toLowerCase());
}

/** The ISO-BMFF `ftyp` brands HEIC/HEIF files carry (a carrier that mislabels the type still gets decoded). */
export function looksLikeHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ftyp = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  if (ftyp !== "ftyp") return false;
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
}

export type ListingJpeg = {
  buffer: Buffer;
  width: number;
  height: number;
  /** The decoded source's long edge (after EXIF orientation), before any cap. */
  sourceLongEdge: number;
  /** True when the source needed a HEIC decode. */
  convertedFromHeic: boolean;
};

/** Pure bytes-in, bytes-out: the whole derivative rule, testable without a database. */
export async function deriveListingJpeg(bytes: Buffer, contentType: string): Promise<ListingJpeg> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const heic = isHeicType(type) || looksLikeHeic(bytes);
  if (!heic && !RASTER_TYPES.has(type)) throw new Error("unsupported_image_type");
  let source: Buffer = bytes;
  if (heic) {
    const { default: convert } = await import("heic-convert");
    source = Buffer.from(await convert({ buffer: bytes as unknown as ArrayBufferLike, format: "JPEG", quality: HEIC_INTERMEDIATE_QUALITY }) as Uint8Array);
  }
  // `rotate()` with no argument applies the EXIF orientation and the output carries no metadata.
  const oriented = await sharp(source, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true });
  const sourceLongEdge = Math.max(oriented.info.width, oriented.info.height);
  const pipeline = sharp(oriented.data, { failOn: "none" });
  const capped = sourceLongEdge > LISTING_PHOTO_MAX_LONG_EDGE
    ? pipeline.resize({ width: LISTING_PHOTO_MAX_LONG_EDGE, height: LISTING_PHOTO_MAX_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    : pipeline;
  const out = await capped.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: out.data, width: out.info.width, height: out.info.height, sourceLongEdge, convertedFromHeic: heic };
}

export type IngestListingPhotoResult =
  | { ok: true; publicUrl: string; originalPath: string; width: number; height: number; small: boolean; sourceLongEdge: number }
  | { ok: false; reason: string };

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "x";
}

export async function ingestListingPhoto(
  db: SupabaseClient,
  input: {
    /** Owner of the PROPERTY: the public derivative is filed under their folder. */
    ownerUserId: string;
    propertyId: string;
    mediaRow: SmsMediaFileRow;
    /** Owner folder the original was stored under, when it differs (a PropLane line text stores under the line owner). */
    mediaOwnerUserId?: string;
  },
): Promise<IngestListingPhotoResult> {
  const { mediaRow } = input;
  // Only a file stored under THIS owner's folder is read: a row id from another workspace never reaches the bucket.
  if (!mediaRow.storage_path.startsWith(`manager/${input.mediaOwnerUserId ?? input.ownerUserId}/`)) return { ok: false, reason: "not_owner_media" };
  if (!input.propertyId.trim()) return { ok: false, reason: "no_property" };
  const download = await db.storage.from(SMS_MEDIA_BUCKET).download(mediaRow.storage_path);
  if (download.error || !download.data) return { ok: false, reason: "original_unreadable" };
  const original = Buffer.from(await download.data.arrayBuffer());
  if (original.byteLength === 0 || original.byteLength > SMS_MEDIA_MAX_BYTES) return { ok: false, reason: "original_size" };
  let derived: ListingJpeg;
  try {
    derived = await deriveListingJpeg(original, mediaRow.content_type);
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === "unsupported_image_type" ? "not_an_image" : "convert_failed" };
  }
  const path = `${safeSegment(input.ownerUserId)}/${safeSegment(input.propertyId)}/sms-${safeSegment(mediaRow.message_sid)}-${mediaRow.media_index}.jpg`;
  const { error } = await db.storage.from(LISTING_MEDIA_BUCKET).upload(path, derived.buffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000",
    upsert: true,
  });
  if (error) return { ok: false, reason: "upload_failed" };
  const publicUrl = db.storage.from(LISTING_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
  return {
    ok: true,
    publicUrl,
    originalPath: mediaRow.storage_path,
    width: derived.width,
    height: derived.height,
    small: derived.sourceLongEdge < LISTING_PHOTO_MIN_LONG_EDGE,
    sourceLongEdge: derived.sourceLongEdge,
  };
}
