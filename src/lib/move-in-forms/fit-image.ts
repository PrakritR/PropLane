import { MAX_CLIENT_IMAGE_BYTES } from "./limits";

export type RenderImage = (source: Blob, maxEdge: number, quality: number) => Promise<Blob | null>;

/** Draws the picture smaller and re-encodes it as JPEG. Null when this browser cannot decode the file. */
const renderInBrowser: RenderImage = async (source, maxEdge, quality) => {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(source); }
  catch { return null; }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  } finally {
    bitmap.close?.();
  }
};

export const IMAGE_TOO_LARGE_MESSAGE = "That photo is too large to upload. Choose a smaller one or take a new photo.";

/**
 * A request body over 4.5 MB never reaches the server (the host drops it), so a phone photo that
 * large is shrunk here first: smaller and re-encoded as JPEG, in a few steps, until it fits. A file
 * already under the cap is sent untouched. A picture that cannot be made to fit (or that this
 * browser cannot decode, like some HEIC files) is refused with a plain message.
 */
export async function fitImageForUpload(
  file: Blob,
  options: { maxBytes?: number; render?: RenderImage } = {},
): Promise<{ blob: Blob; resized: boolean }> {
  const maxBytes = options.maxBytes ?? MAX_CLIENT_IMAGE_BYTES;
  if (file.size <= maxBytes) return { blob: file, resized: false };
  const render = options.render ?? renderInBrowser;
  for (const [edge, quality] of [[2400, 0.85], [1800, 0.8], [1400, 0.7], [1000, 0.6]] as const) {
    const out = await render(file, edge, quality);
    if (!out) break;
    if (out.size <= maxBytes) return { blob: out, resized: true };
  }
  throw new Error(IMAGE_TOO_LARGE_MESSAGE);
}
