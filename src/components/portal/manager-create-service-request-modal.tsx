"use client";

import { useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import {
  ServiceIntakeFormFields,
  type ManagerServiceResidentOption,
  type ServiceIntakeFooterState,
} from "@/components/portal/service-intake-form-fields";
import type { ManagerComposePrefill } from "@/lib/manager-compose-prefill";

export type { ManagerServiceResidentOption };

export function ManagerCreateServiceRequestModal({
  open,
  onClose,
  onSubmitted,
  managerUserId,
  defaultPropertyId,
  defaultResident,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  managerUserId: string | null;
  defaultPropertyId?: string;
  /** When set, the request is created for this resident (property + resident fields locked). */
  defaultResident?: ManagerServiceResidentOption | null;
}) {
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
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
    <Modal
      open={open}
      onClose={onClose}
      dismissBlocked={catalogModalOpen}
      title="Add service"
      dense
      assistantContext="Add service"
      footer={
        footer ? (
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              onClick={footer.submit}
              disabled={footer.saving || !footer.canSubmit}
              data-attr="manager-service-request-save"
            >
              {footer.saving ? "Saving…" : footer.label}
            </Button>
          </ModalFooter>
        ) : undefined
      }
    >
      <ServiceIntakeFormFields
        open={open}
        managerUserId={managerUserId}
        defaultPropertyId={defaultPropertyId}
        defaultResident={defaultResident}
        submitLabel="Add service"
        onComplete={handleComplete}
        onRegisterFooter={setFooter}
        onCatalogOpenChange={setCatalogModalOpen}
      />
    </Modal>
  );
}
