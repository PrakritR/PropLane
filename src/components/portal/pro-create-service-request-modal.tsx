"use client";

import { useEffect, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import {
  ManagerLegacyServiceIntakeForm,
  type ManagerServiceResidentOption,
  type ServiceIntakeFooterState,
} from "@/components/portal/pro-legacy-service-intake-form";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";

export type { ManagerServiceResidentOption };

export function ManagerCreateServiceRequestModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  defaultPropertyId,
  defaultResident,
  defaultNotes,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  defaultPropertyId?: string;
  /** When set, the request is created for this resident (property + resident fields locked). */
  defaultResident?: ManagerServiceResidentOption | null;
  defaultNotes?: string;
}) {
  const [footer, setFooter] = useState<ServiceIntakeFooterState | null>(null);

  useEffect(() => {
    if (!open) setFooter(null);
  }, [open]);

  const handleComplete = (composePrefill?: ManagerComposePrefill | null) => {
    void composePrefill;
    onSubmitted();
    onClose();
  };

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Add service"
      primaryAction={{
        label: footer?.saving ? "Saving…" : footer?.label ?? "Add service",
        onClick: () => footer?.submit(),
        disabled: !footer || footer.saving || !footer.canSubmit,
        loading: footer?.saving,
        dataAttr: "manager-service-request-save",
      }}
    >
      <ManagerLegacyServiceIntakeForm
        open={open}
        managerUserId={managerUserId}
        defaultPropertyId={defaultPropertyId}
        defaultResident={defaultResident}
        defaultNotes={defaultNotes}
        submitLabel="Add service"
        onComplete={handleComplete}
        onRegisterFooter={setFooter}
        onLeaveForCatalog={onClose}
      />
    </PortalDialog>
  );
}
