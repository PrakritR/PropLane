"use client";

import { ManagerTours } from "@/components/portal/pro-tours";
import {
  propertyTourDetailHref,
  propertyTourListHref,
  type ManagerTourBucketId,
  type PropertyStageId,
} from "@/lib/portal-detail-routes";

export function ManagerPropertyTourPanel({
  listingId,
  propertyLabel,
  propertiesBase,
  stage,
  propertyRouteKey,
  tourBucket = "pending",
  tourId,
}: {
  listingId: string;
  managerUserId: string | null;
  propertyLabel: string;
  showToast: (message: string) => void;
  propertiesBase: string;
  stage: PropertyStageId;
  propertyRouteKey: string;
  tourBucket?: ManagerTourBucketId;
  tourId?: string;
}) {
  return (
    <ManagerTours
      embedded
      basePath={propertiesBase}
      bucket={tourBucket}
      tourId={tourId}
      scopedPropertyId={listingId}
      scopedPropertyLabel={propertyLabel}
      tourListHref={(bucket) =>
        propertyTourListHref(propertiesBase, stage, propertyRouteKey, bucket)
      }
      tourDetailHref={(bucket, id) =>
        propertyTourDetailHref(propertiesBase, stage, propertyRouteKey, bucket, id)
      }
    />
  );
}
