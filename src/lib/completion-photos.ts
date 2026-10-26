/**
 * A vendor's completion photos arrive as inline image data URLs. The client downscales them before
 * sending (`imageFileToJpegDataUrl`); this is the server's check that what arrived is an image and
 * small enough to live inside a work order row.
 */
export const MAX_COMPLETION_PHOTOS = 6;
/** Largest single photo, decoded. A 1600px JPEG is a few hundred KB, so this only stops the unscaled. */
export const MAX_COMPLETION_PHOTO_BYTES = 2 * 1024 * 1024;

const IMAGE_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;

export type CompletionPhotosResult =
  | { ok: true; photos: string[] }
  | { ok: false; status: 400 | 413; error: string };

/** Decoded byte length of a base64 payload without allocating it. */
export function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function validateCompletionPhotos(input: unknown): CompletionPhotosResult {
  const raw = Array.isArray(input)
    ? input.filter((url): url is string => typeof url === "string" && url.trim() !== "").map((url) => url.trim())
    : [];
  if (raw.length === 0) {
    return { ok: false, status: 400, error: "Add at least one completion photo before marking this service done." };
  }
  if (raw.length > MAX_COMPLETION_PHOTOS) {
    return { ok: false, status: 400, error: `Up to ${MAX_COMPLETION_PHOTOS} completion photos.` };
  }
  for (const url of raw) {
    const match = IMAGE_DATA_URL_RE.exec(url);
    if (!match) {
      return { ok: false, status: 400, error: "Completion photos must be JPEG, PNG or WebP images." };
    }
    if (base64DecodedBytes(match[2]!) > MAX_COMPLETION_PHOTO_BYTES) {
      return {
        ok: false,
        status: 413,
        error: "A completion photo is larger than 2 MB. Choose a smaller photo and try again.",
      };
    }
  }
  return { ok: true, photos: raw };
}
