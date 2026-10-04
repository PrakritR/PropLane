"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import { ManagerAllServicesPanel } from "@/components/portal/pro-all-services-panel";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PropertyServicesOffersPanel } from "@/components/portal/property-services-offers-panel";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

/**
 * A property record's Operations > Services tab. It is the Services page's own list
 * (`ManagerAllServicesPanel`) scoped to this property - one implementation, never a second list -
 * with the property's service catalog (the offers residents can buy) behind the settings icon.
 */
export function PropertyServicesTab({
  propertyId,
  basePath,
  sub,
  saveTarget,
  managerUserId,
  propertyLabel,
  onUpdated,
  showToast,
}: {
  propertyId: string;
  basePath: string;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onUpdated: () => void;
  showToast: (message: string) => void;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  return (
    <div data-attr="property-services-tab">
      <ManagerAllServicesPanel
        tabId="work-orders"
        basePath={basePath}
        lockedPropertyId={propertyId}
        headerExtra={
          <PortalIconAction
            icon={Settings}
            label="Service settings"
            data-attr="property-services-settings-open"
            onClick={() => setCatalogOpen(true)}
          />
        }
      />
      <PortalDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        title="Service settings"
        size="wizard"
        primaryAction={null}
        dataAttr="property-services-settings"
      >
        <PropertyServicesOffersPanel
          sub={sub}
          saveTarget={saveTarget}
          managerUserId={managerUserId}
          propertyLabel={propertyLabel}
          onUpdated={onUpdated}
          showToast={showToast}
        />
      </PortalDialog>
    </div>
  );
}
