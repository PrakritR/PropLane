"use client";

import type { ReactNode } from "react";
import { ServiceRequestCatalogEditor } from "@/components/portal/service-request-catalog-editor";
import { type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

type RequestsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

/**
 * Per-property request catalog — same list chrome as the application tab.
 */
export function ManagerPropertyRequestsPanel({
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
  onBulkActionsChange,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RequestsSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onBulkActionsChange?: (actions: ReactNode | null) => void;
}) {
  if (!saveTarget || !managerUserId) return null;

  return (
    <ServiceRequestCatalogEditor
      sub={sub}
      saveTarget={saveTarget}
      managerUserId={managerUserId}
      onUpdated={onUpdated}
      showToast={showToast}
      onBulkActionsChange={onBulkActionsChange}
    />
  );
}
