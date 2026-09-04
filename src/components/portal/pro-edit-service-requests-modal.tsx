"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyRequestsPanel } from "@/components/portal/pro-property-requests-panel";
import { ManagerSettingsPropertyField } from "@/components/portal/pro-portal-settings-panels";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * Pick one property, then edit its service-type catalog.
 *
 * Same shape as Edit lease and Edit application: the property dropdown sits on
 * the same page as the catalog it filters, with no Continue step. These three
 * open from the same button in three different sections, so asking the same
 * first question three different ways — a radio list here, a dropdown there —
 * read as three unrelated features.
 */
export function ManagerEditServiceRequestsModal({
  open,
  onClose,
  propertyOptions,
  managerUserId,
  onSaved,
  showToast,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: ManagerPropertyFilterOption[];
  managerUserId: string | null;
  onSaved: () => void;
  showToast: (m: string) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [bulkActions, setBulkActions] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setRefreshTick(0);
      setBulkActions(null);
    }
  }, [open]);

  // Open on the first property rather than an empty Select. The dialog's job is
  // to show service types; opening on "choose a property to see them" makes the
  // manager spend a click before the dialog does anything, and with one
  // property in the portfolio it is a click with a single possible answer.
  useEffect(() => {
    if (open && !selectedId && propertyOptions.length > 0) {
      setSelectedId(propertyOptions[0]!.id);
    }
  }, [open, propertyOptions, selectedId]);

  const resolved = useMemo(() => {
    void refreshTick;
    const id = selectedId.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id);
  }, [selectedId, managerUserId, refreshTick]);

  const selectedLabel = selectedId
    ? (propertyOptions.find((o) => o.id === selectedId)?.label ?? null)
    : null;
  const title = selectedLabel ? `Edit service types · ${selectedLabel}` : "Edit service types";

  const closeAll = () => {
    setSelectedId("");
    setBulkActions(null);
    onClose();
  };

  const sub = resolved ? normalizeManagerListingSubmissionV1(resolved.sub) : null;

  return (
    <Modal
      open={open}
      title={title}
      description="Choose a property, then add or edit its service types."
      onClose={closeAll}
      panelClassName="max-w-4xl"
      dataAttr="services-edit-request-types"
      assistantContext="Edit service types"
      footer={
        bulkActions ? (
          <ModalFooter className="w-full justify-start">{bulkActions}</ModalFooter>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions.map((option) => ({ id: option.id, label: option.label }))}
          propertyId={selectedId}
          onPropertyIdChange={setSelectedId}
        />

        {!selectedId ? (
          <p className="text-sm text-muted">Choose a property to see its service types.</p>
        ) : !resolved || !managerUserId || !sub ? (
          <p className="text-sm text-muted">Could not load service types for that property.</p>
        ) : (
          <ManagerPropertyRequestsPanel
            key={selectedId}
            sub={sub}
            saveTarget={resolved.saveTarget}
            managerUserId={managerUserId}
            onUpdated={() => {
              setRefreshTick((t) => t + 1);
              onSaved();
            }}
            showToast={showToast}
            onBulkActionsChange={setBulkActions}
          />
        )}
      </div>
    </Modal>
  );
}
