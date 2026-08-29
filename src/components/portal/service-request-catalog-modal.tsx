"use client";

import { useCallback, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import { ServiceRequestCatalogEditor } from "@/components/portal/service-request-catalog-editor";
import { type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

type RequestsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string };

/** Popup wrapper around the shared request catalog editor. */
export function ServiceRequestCatalogModal({
  open,
  onClose,
  title = "Service types",
  description = "Residents can book these services from their portal. Add presets or create custom types for this property.",
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
  onOfferSaved,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  sub: ManagerListingSubmissionV1;
  saveTarget: RequestsSaveTarget;
  managerUserId: string;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onOfferSaved?: (offerId: string) => void;
}) {
  const addHandlerRef = useRef<(() => void) | null>(null);
  const [nestedEditOpen, setNestedEditOpen] = useState(false);

  const registerAddHandler = useCallback((openAddCustom: (() => void) | null) => {
    addHandlerRef.current = openAddCustom;
  }, []);

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      dismissBlocked={nestedEditOpen}
      dense
      panelClassName="max-w-2xl"
      dataAttr="service-request-catalog-modal"
    >
      <ServiceRequestCatalogEditor
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        onUpdated={onUpdated}
        showToast={showToast}
        onOfferSaved={onOfferSaved}
        onRegisterAddCustom={registerAddHandler}
        onNestedModalOpenChange={setNestedEditOpen}
      />
      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          icon={PORTAL_LIST_ADD_ICONS.request}
          onClick={() => addHandlerRef.current?.()}
          dataAttr="service-request-catalog-add"
        />
      </div>
    </Modal>
  );
}
