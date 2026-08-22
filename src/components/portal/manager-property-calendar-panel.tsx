"use client";

import { useMemo } from "react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPropertyTourPanel } from "@/components/portal/manager-property-tour-panel";
import { ManagerPropertyBookingsPanel } from "@/components/portal/manager-property-bookings-panel";
import {
  PROPERTY_CALENDAR_SUB_TABS,
  PROPERTY_CALENDAR_SUB_TAB_LABELS,
  propertyCalendarSubHref,
  type PropertyCalendarSubTabId,
} from "@/lib/portal-detail-routes";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export function ManagerPropertyCalendarPanel({
  propertiesBase,
  stage,
  propertyRouteKey,
  calendarSubTab,
  listingId,
  propertyId,
  managerUserId,
  propertyLabel,
  submission,
  showToast,
  onRegisterSendTour,
}: {
  propertiesBase: string;
  stage: string;
  propertyRouteKey: string;
  calendarSubTab: PropertyCalendarSubTabId;
  listingId: string;
  propertyId: string;
  managerUserId: string | null;
  propertyLabel: string;
  submission: ManagerListingSubmissionV1 | null;
  showToast: (message: string) => void;
  onRegisterSendTour?: (openSendTour: (() => void) | null) => void;
}) {
  const subTabs = useMemo(
    () =>
      // "bookings" retired — drive the strip off the canonical list so it cannot drift again.
      PROPERTY_CALENDAR_SUB_TABS.map((id) => ({
        id,
        label: PROPERTY_CALENDAR_SUB_TAB_LABELS[id],
        href: propertyCalendarSubHref(propertiesBase, stage, propertyRouteKey, id),
        dataAttr: `property-calendar-subtab-${id}`,
      })),
    [propertiesBase, propertyRouteKey, stage],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PortalListControlStack
        destinations={subTabs}
        activeDestinationId={calendarSubTab}
        destinationAriaLabel="Property calendar views"
      />
      {calendarSubTab === "tours" ? (
        <ManagerPropertyTourPanel
          listingId={listingId}
          managerUserId={managerUserId}
          propertyLabel={propertyLabel}
          showToast={showToast}
          onRegisterSendTour={onRegisterSendTour}
        />
      ) : (
        <ManagerPropertyBookingsPanel
          propertyId={propertyId}
          propertyLabel={propertyLabel}
          submission={submission}
          managerUserId={managerUserId}
          showToast={showToast}
        />
      )}
    </div>
  );
}
