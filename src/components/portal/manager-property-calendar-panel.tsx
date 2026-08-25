"use client";

import { ManagerPropertyBookingsPanel } from "@/components/portal/manager-property-bookings-panel";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Property calendar is bookings-only; tour scheduling lives on the Tours tab. */
export function ManagerPropertyCalendarPanel({
  propertyId,
  managerUserId,
  propertyLabel,
  submission,
  showToast,
}: {
  propertiesBase?: string;
  stage?: string;
  propertyRouteKey?: string;
  calendarSubTab?: string;
  listingId?: string;
  propertyId: string;
  managerUserId: string | null;
  propertyLabel: string;
  submission: ManagerListingSubmissionV1 | null;
  showToast: (message: string) => void;
  onRegisterSendTour?: (openSendTour: (() => void) | null) => void;
}) {
  return (
    <ManagerPropertyBookingsPanel
      propertyId={propertyId}
      propertyLabel={propertyLabel}
      submission={submission}
      managerUserId={managerUserId}
      showToast={showToast}
    />
  );
}
