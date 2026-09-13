import { uploadLeaseTemplateDataUrl } from "@/lib/lease-template-storage";
import { uploadListingDataUrl } from "@/lib/listing-media-client";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export type ListingSubmissionMediaUpload = {
  submission: ManagerListingSubmissionV1;
  /** Attachments whose upload failed. They are dropped, never kept as base64. */
  failedCount: number;
};

/**
 * Every attachment in a listing submission that is still a `data:` URL is
 * uploaded before the records API sees it. The v1 wizard has done this for
 * years; the v2 wizard uploaded photos on pick but still let lease templates,
 * floor plans, and move-in clips ride into `property_data` as multi-megabyte
 * base64 — which made `POST /api/property-records` fail and surfaced as
 * "Check your connection."
 */
export async function uploadListingSubmissionMedia(
  sub: ManagerListingSubmissionV1,
): Promise<ListingSubmissionMediaUpload> {
  let failedCount = 0;

  async function uploadOne(url: string | null | undefined): Promise<string | null> {
    if (!url) return url ?? null;
    try {
      return await uploadListingDataUrl(url);
    } catch (err) {
      console.error("listing-submission-media-upload: attachment upload failed", err);
      failedCount += 1;
      return null;
    }
  }

  async function uploadAll(urls: string[]): Promise<string[]> {
    const settled = await Promise.all(urls.map((u) => uploadOne(u)));
    return settled.filter((u): u is string => typeof u === "string" && u.length > 0);
  }

  async function uploadLeaseTemplate(url: string | null | undefined, name?: string | null) {
    if (!url) return url ?? null;
    try {
      return await uploadLeaseTemplateDataUrl(url, name);
    } catch (err) {
      console.error("listing-submission-media-upload: lease template upload failed", err);
      failedCount += 1;
      return null;
    }
  }

  const [
    housePhotos,
    houseVideo,
    houseMoveInPhotos,
    houseMoveInVideo,
    leaseTemplateDocUrl,
    propertyLeaseTemplates,
    propertyFloorPlan,
    floorPlanByLabel,
    rooms,
    bathrooms,
    sharedSpaces,
  ] = await Promise.all([
    uploadAll(sub.housePhotoDataUrls ?? []),
    uploadOne(sub.houseVideoDataUrl),
    uploadAll(sub.houseMoveInPhotoDataUrls ?? []),
    uploadOne(sub.houseMoveInVideoDataUrl),
    uploadLeaseTemplate(sub.leaseTemplateDocUrl, sub.leaseTemplateDocName),
    sub.propertyLeaseTemplates
      ? Promise.all(
          sub.propertyLeaseTemplates.map(async (t) => ({
            ...t,
            leaseTemplateDocUrl: await uploadLeaseTemplate(t.leaseTemplateDocUrl, t.leaseTemplateDocName),
          })),
        )
      : Promise.resolve(undefined),
    uploadOne(sub.propertyFloorPlanDataUrl),
    (async () => {
      const entries = Object.entries(sub.floorPlanByLabel ?? {});
      if (entries.length === 0) return {} as Record<string, string>;
      const uploaded = await Promise.all(entries.map(async ([label, url]) => [label, await uploadOne(url)] as const));
      return Object.fromEntries(
        uploaded.filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
      ) as Record<string, string>;
    })(),
    Promise.all(
      sub.rooms.map(async (r) => ({
        ...r,
        photoDataUrls: await uploadAll(r.photoDataUrls ?? []),
        videoDataUrl: await uploadOne(r.videoDataUrl),
      })),
    ),
    Promise.all(
      sub.bathrooms.map(async (b) => ({
        ...b,
        photoDataUrls: await uploadAll(b.photoDataUrls ?? []),
        videoDataUrl: await uploadOne(b.videoDataUrl),
      })),
    ),
    Promise.all(
      sub.sharedSpaces.map(async (s) => ({
        ...s,
        photoDataUrls: await uploadAll(s.photoDataUrls ?? []),
        videoDataUrl: await uploadOne(s.videoDataUrl),
      })),
    ),
  ]);

  return {
    submission: {
      ...sub,
      housePhotoDataUrls: housePhotos,
      houseVideoDataUrl: houseVideo,
      houseMoveInPhotoDataUrls: houseMoveInPhotos,
      houseMoveInVideoDataUrl: houseMoveInVideo,
      leaseTemplateDocUrl,
      ...(propertyLeaseTemplates ? { propertyLeaseTemplates } : {}),
      propertyFloorPlanDataUrl: propertyFloorPlan,
      floorPlanByLabel: Object.keys(floorPlanByLabel).length > 0 ? floorPlanByLabel : undefined,
      rooms,
      bathrooms,
      sharedSpaces,
    },
    failedCount,
  };
}
