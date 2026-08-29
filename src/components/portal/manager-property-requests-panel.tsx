"use client";

import { useCallback, useRef } from "react";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
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
  onRegisterAddRequest,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RequestsSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
  /** Parent header "Add service" — opens the custom service-type form. */
  onRegisterAddRequest?: (openAdd: (() => void) | null) => void;
}) {
  const addHandlerRef = useRef<(() => void) | null>(null);

  const registerAddHandler = useCallback(
    (openAddCustom: (() => void) | null) => {
      addHandlerRef.current = openAddCustom;
      onRegisterAddRequest?.(openAddCustom);
    },
    [onRegisterAddRequest],
  );

  if (!saveTarget || !managerUserId) return null;

  return (
    <>
      <ServiceRequestCatalogEditor
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        onUpdated={onUpdated}
        showToast={showToast}
        onRegisterAddCustom={registerAddHandler}
      />

      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          icon={PORTAL_LIST_ADD_ICONS.request}
          onClick={() => addHandlerRef.current?.()}
          dataAttr="manager-service-request-add"
        />
      </div>
    </>
  );
}
