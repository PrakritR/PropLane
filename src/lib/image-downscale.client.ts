/** Long edge and quality for a photo that rides inside a JSON body (completion photos). */
export const JSON_PHOTO_MAX_EDGE = 1600;
export const JSON_PHOTO_JPEG_QUALITY = 0.82;

/**
 * A picked image as a JPEG data URL whose long edge is at most `maxEdge`. Throws when the browser
 * cannot decode the file (e.g. HEIC on desktop) rather than sending an unscaled original that the
 * server would refuse for size.
 */
export async function imageFileToJpegDataUrl(
  file: File,
  maxEdge: number = JSON_PHOTO_MAX_EDGE,
  quality: number = JSON_PHOTO_JPEG_QUALITY,
): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`Could not read ${file.name || "that photo"}. Try a JPEG or PNG.`);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process that photo.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}
