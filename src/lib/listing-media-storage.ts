import { isDemoModeActive } from "@/lib/demo/demo-session";
import { deleteSubmissionLeaseTemplates } from "@/lib/lease-template-storage";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Storage bucket every listing photo/video/floor plan/lease template is uploaded to. */
export const LISTING_MEDIA_BUCKET = "listing-photos";

const PUBLIC_OBJECT_MARKER = `/storage/v1/object/public/${LISTING_MEDIA_BUCKET}/`;

async function shouldUseServerListingCleanup(): Promise<boolean> {
  const response = await fetch("/api/listing-photos", { credentials: "same-origin" });
  if (!response.ok) return false;
  const body = await response.json().catch(() => null) as { serverUpload?: unknown } | null;
  return body?.serverUpload === true;
}

async function deleteClassifiedListingMedia(paths: string[]): Promise<void> {
  const response = await fetch("/api/listing-photos", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not remove listing media.");
  }
}

/**
 * Object path inside `listing-photos` for a public storage URL, or null when the
 * URL points somewhere else (a still-unuploaded `data:` URL, a demo asset, or a
 * third-party link a manager pasted in).
 */
export function listingMediaObjectPath(url: string | null | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  const at = raw.indexOf(PUBLIC_OBJECT_MARKER);
  if (at === -1) return null;
  const path = raw.slice(at + PUBLIC_OBJECT_MARKER.length).split(/[?#]/)[0] ?? "";
  const decoded = (() => {
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  })();
  return decoded.trim() || null;
}

/** Every media URL a submission references, across house, rooms, bathrooms and shared spaces. */
export function collectSubmissionMediaUrls(sub: ManagerListingSubmissionV1): string[] {
  const out: string[] = [];
  const push = (url: string | null | undefined) => {
    if (url) out.push(url);
  };
  const pushAll = (urls: string[] | null | undefined) => {
    for (const url of urls ?? []) push(url);
  };

  pushAll(sub.housePhotoDataUrls);
  push(sub.houseVideoDataUrl);
  // New templates live in the PRIVATE `lease-templates` bucket and are reclaimed
  // by `deleteSubmissionLeaseTemplates`; this only still matches a LEGACY template
  // uploaded to `listing-photos` before the split, which must not be stranded.
  push(sub.leaseTemplateDocUrl);
  for (const template of sub.propertyLeaseTemplates ?? []) push(template?.leaseTemplateDocUrl);
  push(sub.propertyFloorPlanDataUrl);
  for (const url of Object.values(sub.floorPlanByLabel ?? {})) push(url);
  for (const room of sub.rooms ?? []) {
    pushAll(room.photoDataUrls);
    push(room.videoDataUrl);
  }
  for (const bath of sub.bathrooms ?? []) {
    pushAll(bath.photoDataUrls);
    push(bath.videoDataUrl);
  }
  for (const space of sub.sharedSpaces ?? []) {
    pushAll(space.photoDataUrls);
    push(space.videoDataUrl);
  }
  return out;
}

/** Distinct `listing-photos` object paths a submission references. */
export function collectSubmissionMediaPaths(sub: ManagerListingSubmissionV1 | null | undefined): Set<string> {
  if (!sub) return new Set();
  return new Set(
    collectSubmissionMediaUrls(sub).map(listingMediaObjectPath).filter((p): p is string => Boolean(p)),
  );
}

/**
 * Best-effort reclamation of the storage objects a discarded submission owned.
 * Egress and storage are a real constraint on the free plan, so deleting a draft
 * must not strand its uploads in the bucket.
 *
 * An uploaded object's URL is carried on the submission, not owned by the record
 * that stored it, so two records can legitimately point at the same object — most
 * visibly the two draft rows a partially-failed id re-key leaves behind, which
 * hold the very same submission. `stillReferencedBy` must therefore carry every
 * submission that survives the delete; a path any of them still uses is left
 * alone, because stripping a surviving record's photos is worse than stranding
 * an object. Never throws — losing the cleanup is strictly better than failing the delete
 * the manager asked for.
 */
export async function deleteSubmissionMediaObjects(
  sub: ManagerListingSubmissionV1 | null | undefined,
  stillReferencedBy: Iterable<ManagerListingSubmissionV1 | null | undefined> = [],
): Promise<void> {
  if (!sub || typeof window === "undefined" || isDemoModeActive()) return;
  const survivors = [...stillReferencedBy];
  // Lease templates live in a separate private bucket the browser cannot touch,
  // so they are reclaimed through their authorizing route — same skip rule.
  await deleteSubmissionLeaseTemplates(sub, survivors);
  const retained = new Set<string>();
  for (const other of survivors) {
    for (const path of collectSubmissionMediaPaths(other)) retained.add(path);
  }
  const paths = Array.from(collectSubmissionMediaPaths(sub)).filter((p) => !retained.has(p));
  if (paths.length === 0) return;
  try {
    if (await shouldUseServerListingCleanup()) {
      await deleteClassifiedListingMedia(paths);
      return;
    }
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
    const db = createSupabaseBrowserClient();
    // Storage RLS scopes removal to the owner's `${userId}/` prefix, so a path
    // belonging to another manager is rejected rather than deleted.
    await db.storage.from(LISTING_MEDIA_BUCKET).remove(paths);
  } catch (err) {
    console.error("listing-media-storage: media cleanup failed", err);
  }
}
