"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useConfirm } from "@/components/providers/app-ui-provider";
import {
  createManagerListingServiceOption,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";

export function ServiceOfferingFields({
  row,
  onPatch,
}: {
  row: ManagerListingServiceOption;
  onPatch: (patch: Partial<ManagerListingServiceOption>) => void;
}) {
  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-border text-primary"
          checked={row.available}
          onChange={(e) => onPatch({ available: e.target.checked })}
        />
        <span className="text-sm font-medium text-foreground">Available to residents</span>
      </label>
      <div>
        <p className="text-sm font-medium text-foreground">Name</p>
        <Input
          value={row.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="e.g. Parking spot"
          className="mt-1"
        />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">Description</p>
        <Input
          value={row.description}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder="What the resident gets"
          className="mt-1"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-foreground">Price</p>
          <Input
            value={row.price}
            onChange={(e) => onPatch({ price: e.target.value })}
            placeholder="e.g. $25/mo"
            className="mt-1"
          />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Deposit</p>
          <Input
            value={row.deposit}
            onChange={(e) => onPatch({ deposit: e.target.value })}
            placeholder="e.g. $100"
            className="mt-1"
          />
        </div>
      </div>
    </>
  );
}

function normalizeOffering(row: ManagerListingServiceOption): ManagerListingServiceOption {
  return {
    ...row,
    name: row.name.trim(),
    description: row.description.trim(),
    price: row.price.trim(),
    deposit: row.deposit.trim(),
  };
}

/** Edit a single service offering — saves listing submission on Save. */
export function ServiceOfferingEditModal({
  open,
  offering,
  isNew = false,
  sub,
  saveTarget,
  managerUserId,
  onClose,
  onSaved,
  showToast,
  entityLabel = "service",
}: {
  open: boolean;
  offering: ManagerListingServiceOption | null;
  isNew?: boolean;
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  onClose: () => void;
  onSaved: () => void;
  showToast: (m: string) => void;
  entityLabel?: string;
}) {
  const [draft, setDraft] = useState<ManagerListingServiceOption>(() =>
    offering ? { ...offering } : createManagerListingServiceOption(),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(offering ? { ...offering } : createManagerListingServiceOption());
    setError(null);
  }, [open, offering]);

  const patch = (patchRow: Partial<ManagerListingServiceOption>) =>
    setDraft((prev) => ({ ...prev, ...patchRow }));

  const save = () => {
    const normalized = normalizeOffering(draft);
    if (!normalized.name) {
      setError(`${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} name is required.`);
      return;
    }

    const offers = sub.serviceRequestOptions ?? [];
    const nextOffers = isNew
      ? [normalized, ...offers]
      : offers.map((o) => (o.id === normalized.id ? normalized : o));

    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: nextOffers };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast(`Could not save ${entityLabel}.`);
      return;
    }
    const label = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);
    showToast(isNew ? `${label} added.` : `${label} saved.`);
    onClose();
    onSaved();
  };

  const confirm = useConfirm();

  const remove = async () => {
    if (isNew || !offering) return;
    const label = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);
    if (!(await confirm({ description: `Delete this ${entityLabel}?` }))) return;
    const nextOffers = (sub.serviceRequestOptions ?? []).filter((o) => o.id !== offering.id);
    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: nextOffers };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast(`Could not delete ${entityLabel}.`);
      return;
    }
    showToast(`${label} deleted.`);
    onClose();
    onSaved();
  };

  return (
    <Modal
      open={open}
      title={
        isNew
          ? `Add ${entityLabel}`
          : `Edit ${entityLabel}`
      }
      onClose={onClose}
      panelClassName="max-w-lg"
      stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
      footer={
        <ModalFooter className="w-full">
          {!isNew && offering ? (
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
              data-attr="service-offering-delete"
              onClick={remove}
            >
              Delete
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            data-attr="service-offering-save"
            onClick={save}
          >
            Save
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <ServiceOfferingFields row={draft} onPatch={patch} />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    </Modal>
  );
}
