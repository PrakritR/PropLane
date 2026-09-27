import type { ResidentTourView } from "@/lib/tour-resident-link.server";
import type { ResidentTourBucketId } from "@/lib/portal-detail-routes";

export function residentTourBucketForView(tour: ResidentTourView): ResidentTourBucketId {
  if (tour.confirmed) return "confirmed";
  const status = tour.status.trim().toLowerCase();
  // A tour the resident withdrew files with declined ones: it is over either way.
  if (status === "declined" || status === "cancelled" || status === "canceled") return "declined";
  return "pending";
}

const RESIDENT_TOUR_BUCKET_LABEL: Record<ResidentTourBucketId, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  declined: "Declined",
};

/**
 * Status as plain text for one merged tour list row (C120) — the same words the
 * three tabs used to carry, now read per-row instead of picking which tab you're
 * looking at. Never a pill: a status is a fact beside the row, not a badge.
 */
export function residentTourStatusLabel(tour: ResidentTourView): string {
  return RESIDENT_TOUR_BUCKET_LABEL[residentTourBucketForView(tour)];
}

export function sortResidentTourViews(tours: ResidentTourView[]): ResidentTourView[] {
  return [...tours].sort((a, b) => {
    const aTime = Date.parse(a.createdAt ?? "") || 0;
    const bTime = Date.parse(b.createdAt ?? "") || 0;
    return bTime - aTime;
  });
}

export function countResidentToursByBucket(tours: ResidentTourView[]): Record<ResidentTourBucketId, number> {
  return tours.reduce(
    (acc, tour) => {
      acc[residentTourBucketForView(tour)] += 1;
      return acc;
    },
    { pending: 0, confirmed: 0, declined: 0 } satisfies Record<ResidentTourBucketId, number>,
  );
}
