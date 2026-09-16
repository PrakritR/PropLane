"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { ManagerSettingsPropertyField } from "@/components/portal/pro-portal-settings-panels";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";

export function ManagerPropertyLeaseFormEditor({
  active,
  propertyOptions,
  initialPropertyId,
  managerUserId,
  onSaved,
  showToast,
  onBulkActionsChange,
}: {
  active: boolean;
  propertyOptions: { id: string; label: string }[];
  initialPropertyId?: string;
  managerUserId: string | null;
  onSaved: () => void;
  showToast: (m: string) => void;
  onBulkActionsChange: (actions: ReactNode | null) => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [bulkActions, setBulkActions] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!active) {
      setSelectedId("");
      setEditorRevision(0);
      setBulkActions(null);
    }
  }, [active]);

  useEffect(() => {
    if (!active || selectedId) return;
    const preferred = initialPropertyId?.trim();
    if (preferred && propertyOptions.some((option) => option.id === preferred)) {
      setSelectedId(preferred);
      return;
    }
    if (propertyOptions.length > 0) {
      setSelectedId(propertyOptions[0]!.id);
    }
  }, [active, initialPropertyId, propertyOptions, selectedId]);

  useEffect(() => {
    onBulkActionsChange(bulkActions);
    return () => onBulkActionsChange(null);
  }, [bulkActions, onBulkActionsChange]);

  const syncedSub = useMemo(() => {
    const id = selectedId.trim();
    if (!id || !managerUserId) return null;
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, id);
    if (!hit) return null;
    return syncPropertyLeaseTemplatesFromListing(hit.sub);
  }, [editorRevision, selectedId, managerUserId]);

  const resolvedSaveTarget = useMemo(() => {
    const id = selectedId.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id)?.saveTarget ?? null;
  }, [editorRevision, selectedId, managerUserId]);

  const selectedLabel = selectedId
    ? (propertyOptions.find((option) => option.id === selectedId)?.label ?? null)
    : null;

  return (
    <div className="space-y-4" data-attr="manager-settings-lease-form">
      <ManagerSettingsPropertyField
        propertyOptions={propertyOptions}
        propertyId={selectedId}
        onPropertyIdChange={(next) => {
          setBulkActions(null);
          setSelectedId(next);
        }}
      />

      {propertyOptions.length === 0 ? null : !selectedId ? (
        <p className="text-sm text-muted">Choose a property to see its leases.</p>
      ) : !resolvedSaveTarget || !managerUserId || !syncedSub ? (
        <p className="text-sm text-muted">Could not load leases for that property.</p>
      ) : (
        <ManagerPropertyLeasePanel
          key={selectedId}
          sub={syncedSub}
          saveTarget={resolvedSaveTarget}
          managerUserId={managerUserId}
          propertyHint={selectedLabel ? { buildingName: selectedLabel } : undefined}
          propertyId={selectedId}
          propertyLabel={selectedLabel}
          onBulkActionsChange={setBulkActions}
          onUpdated={() => {
            setEditorRevision((revision) => revision + 1);
            onSaved();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

/**
 * Pick ONE property, then manage its lease templates.
 *
 * The settings sheet now hosts this editor on the Form pane; this modal
 * remains for any standalone caller.
 *
 * The panel's own selection action is published up and rendered in this modal's
 * footer: `BulkActionBar` is `position: fixed`, so left to itself it escaped to
 * the page behind the dialog.
 */
export function ManagerEditLeasesModal({
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
  const [bulkActions, setBulkActions] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) setBulkActions(null);
  }, [open]);

  const closeAll = () => {
    setBulkActions(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="Edit lease"
      onClose={closeAll}
      panelClassName="max-w-4xl"
      assistantContext="Edit lease"
      footer={
        bulkActions ? (
          <ModalFooter className="w-full justify-start">{bulkActions}</ModalFooter>
        ) : undefined
      }
    >
      <ManagerPropertyLeaseFormEditor
        active={open}
        propertyOptions={propertyOptions}
        managerUserId={managerUserId}
        onSaved={onSaved}
        showToast={showToast}
        onBulkActionsChange={setBulkActions}
      />
    </Modal>
  );
}
