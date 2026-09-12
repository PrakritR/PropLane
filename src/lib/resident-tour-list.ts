import type { ResidentTourView } from "@/lib/tour-resident-link.server";
import type { ResidentTourBucketId } from "@/lib/portal-detail-routes";

export function residentTourBucketForView(tour: ResidentTourView): ResidentTourBucketId {
  if (tour.confirmed) return "confirmed";
  const status = tour.status.trim().toLowerCase();
  // A tour the resident withdrew files with declined ones: it is over either way.
  if (status === "declined" || status === "cancelled" || status === "canceled") return "declined";
  return "pending";
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
