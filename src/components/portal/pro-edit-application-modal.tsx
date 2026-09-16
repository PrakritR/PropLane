"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerSettingsPropertyField } from "@/components/portal/pro-portal-settings-panels";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";

export function ManagerPropertyApplicationFormEditor({
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
    return syncPropertyApplicationTemplatesFromListing(hit.sub);
  }, [editorRevision, selectedId, managerUserId]);

  const resolvedSaveTarget = useMemo(() => {
    const id = selectedId.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id)?.saveTarget ?? null;
  }, [editorRevision, selectedId, managerUserId]);

  return (
    <div className="space-y-4" data-attr="manager-settings-application-form">
      <ManagerSettingsPropertyField
        propertyOptions={propertyOptions}
        propertyId={selectedId}
        onPropertyIdChange={(next) => {
          setBulkActions(null);
          setSelectedId(next);
        }}
      />

      {propertyOptions.length === 0 ? null : !selectedId ? (
        <p className="text-sm text-muted">Choose a property to see its applications.</p>
      ) : !resolvedSaveTarget || !managerUserId || !syncedSub ? (
        <p className="text-sm text-muted">Could not load applications for that property.</p>
      ) : (
        <ManagerPropertyApplicationQuestionsPanel
          key={selectedId}
          sub={syncedSub}
          saveTarget={resolvedSaveTarget}
          managerUserId={managerUserId}
          listingId={resolvedSaveTarget.mode === "listing" ? resolvedSaveTarget.saveId : selectedId}
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
 * Pick ONE property, then manage its application templates.
 *
 * Same shape as Edit lease. The settings sheet now hosts this editor on the
 * Form pane; this modal remains for any standalone caller.
 *
 * The panel's own selection action is published up and rendered in this
 * modal's footer, because `BulkActionBar` is `position: fixed` and would
 * otherwise escape to the page behind the dialog.
 */
export function ManagerEditApplicationModal({
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
      title="Edit application"
      onClose={closeAll}
      panelClassName="max-w-4xl"
      assistantContext="Edit application"
      footer={
        bulkActions ? (
          <ModalFooter className="w-full justify-start">{bulkActions}</ModalFooter>
        ) : undefined
      }
    >
      <ManagerPropertyApplicationFormEditor
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
