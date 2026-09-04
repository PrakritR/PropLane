"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerSettingsPropertyField } from "@/components/portal/manager-portal-settings-panels";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/manager-property-application-questions-panel";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyApplicationTemplatesFromListing } from "@/lib/property-application-template-sync";

/**
 * Pick ONE property, then manage its application templates.
 *
 * Same shape as Edit lease, deliberately — these open from the same pair of
 * buttons on their respective pages, so asking the same first question two
 * different ways would read as two unrelated features. The property dropdown
 * is the one Applications settings uses, on the same page as the applications
 * it filters: no Continue step.
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
  const [selectedId, setSelectedId] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [bulkActions, setBulkActions] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setEditorRevision(0);
      setBulkActions(null);
    }
  }, [open]);

  // One possible answer is not a question worth asking.
  useEffect(() => {
    if (open && !selectedId && propertyOptions.length === 1) {
      setSelectedId(propertyOptions[0]!.id);
    }
  }, [open, propertyOptions, selectedId]);

  const resolved = useMemo(() => {
    const id = selectedId.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id);
  }, [editorRevision, selectedId, managerUserId]);

  const selectedLabel = selectedId
    ? (propertyOptions.find((o) => o.id === selectedId)?.label ?? null)
    : null;
  const title = selectedLabel ? `Edit application · ${selectedLabel}` : "Edit application";

  const closeAll = () => {
    setSelectedId("");
    setBulkActions(null);
    onClose();
  };

  const syncedSub = resolved ? syncPropertyApplicationTemplatesFromListing(resolved.sub) : null;

  return (
    <Modal
      open={open}
      title={title}
      description="Choose a property, then add an application or edit questions for each stay type."
      onClose={closeAll}
      panelClassName="max-w-4xl"
      assistantContext="Edit application"
      footer={bulkActions ? <ModalFooter className="w-full">{bulkActions}</ModalFooter> : undefined}
    >
      <div className="space-y-4">
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions.map((option) => ({ id: option.id, label: option.label }))}
          propertyId={selectedId}
          onPropertyIdChange={setSelectedId}
        />

        {!selectedId ? (
          <p className="text-sm text-muted">Choose a property to see its applications.</p>
        ) : !resolved || !managerUserId || !syncedSub ? (
          <p className="text-sm text-muted">Could not load applications for that property.</p>
        ) : (
          <ManagerPropertyApplicationQuestionsPanel
            key={selectedId}
            sub={syncedSub}
            saveTarget={resolved.saveTarget}
            managerUserId={managerUserId}
            listingId={resolved.saveTarget.mode === "listing" ? resolved.saveTarget.saveId : selectedId}
            onBulkActionsChange={setBulkActions}
            onUpdated={() => {
              setEditorRevision((revision) => revision + 1);
              onSaved();
            }}
            showToast={showToast}
          />
        )}
      </div>
    </Modal>
  );
}
