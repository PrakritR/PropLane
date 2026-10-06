"use client";

import { PropertyServicesOffersPanel } from "@/components/portal/property-services-offers-panel";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

/**
 * A property record's Operations > Services tab: the services OFFERED at this property, under Long term /
 * Short term tabs. Service requests are not listed here - they live on the main Services page, which
 * already filters by property.
 */
export function PropertyServicesTab({
  sub,
  saveTarget,
  managerUserId,
  propertyLabel,
  onUpdated,
  showToast,
}: {
  /** Passed by the property record; requests no longer render here, so unused. */
  propertyId?: string;
  basePath?: string;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onUpdated: () => void;
  showToast: (message: string) => void;
}) {
  return (
    <div data-attr="property-services-tab">
      <PropertyServicesOffersPanel
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        propertyLabel={propertyLabel}
        onUpdated={onUpdated}
        showToast={showToast}
      />
    </div>
  );
}
