import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { MANAGER_DOCUMENTS_BUCKET } from "@/lib/documents/manager-documents";

/**
 * A vendor's completion photos live in the private manager documents bucket under the owning
 * manager's prefix, and row_data keeps only their paths. Bytes leave the bucket only as short-lived
 * signed URLs minted after an ownership check (the egress rule: no base64 inside row_data).
 */
export const COMPLETION_PHOTO_SIGNED_URL_TTL_SECONDS = 600;

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function completionPhotoPrefix(managerUserId: string, workOrderId: string): string {
  return `manager/${managerUserId}/service-completion/${workOrderId}/`;
}

export function completionPhotoPathBelongsTo(path: string, managerUserId: string, workOrderId: string): boolean {
  return path.startsWith(completionPhotoPrefix(managerUserId, workOrderId)) && !path.includes("..");
}

/** Upload validated image data URLs; returns their storage paths. Throws on the first failure. */
export async function uploadCompletionPhotos(
  db: SupabaseClient,
  input: { managerUserId: string; workOrderId: string; dataUrls: string[] },
): Promise<string[]> {
  const paths: string[] = [];
  for (const dataUrl of input.dataUrls) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error("Completion photos must be JPEG, PNG or WebP images.");
    const mime = match[1]!.toLowerCase();
    const bytes = Buffer.from(match[2]!, "base64");
    const path = `${completionPhotoPrefix(input.managerUserId, input.workOrderId)}${crypto.randomUUID()}.${EXT[mime] ?? "jpg"}`;
    const { error } = await db.storage.from(MANAGER_DOCUMENTS_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
    if (error) throw new Error(`Could not store the completion photo: ${error.message}`);
    paths.push(path);
  }
  return paths;
}

/** Signed URLs for paths that really belong to this manager's work order; anything else is dropped. */
export async function signCompletionPhotoPaths(
  db: SupabaseClient,
  input: { managerUserId: string; workOrderId: string; paths: string[] },
): Promise<string[]> {
  const urls: string[] = [];
  for (const path of input.paths) {
    if (!completionPhotoPathBelongsTo(path, input.managerUserId, input.workOrderId)) continue;
    const { data } = await db.storage.from(MANAGER_DOCUMENTS_BUCKET).createSignedUrl(path, COMPLETION_PHOTO_SIGNED_URL_TTL_SECONDS);
    if (data?.signedUrl) urls.push(data.signedUrl);
  }
  return urls;
}
