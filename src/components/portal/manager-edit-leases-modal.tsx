"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyLeasePanel } from "@/components/portal/manager-property-lease-panel";
import { ManagerSettingsPropertyField } from "@/components/portal/manager-portal-settings-panels";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";

/**
 * Pick ONE property, then manage its lease templates.
 *
 * The property step is the same dropdown Leases settings uses, deliberately:
 * these two open from adjacent buttons and asking the same question two
 * different ways — a checkbox list here, a select there — reads as two
 * unrelated features. It was a multi-select ("apply to all") before; a single
 * property is the captain's call, and it also removes the quiet hazard of one
 * Save rewriting the lease templates of every house at once.
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
  const [selectedId, setSelectedId] = useState("");
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setEditingPropertyId(null);
      setEditorRevision(0);
    }
  }, [open]);

  // A single-property portfolio has one possible answer, so asking is a click
  // for nothing — preselect it and let Continue be the only step.
  useEffect(() => {
    if (open && !selectedId && propertyOptions.length === 1) {
      setSelectedId(propertyOptions[0]!.id);
    }
  }, [open, propertyOptions, selectedId]);

  const resolved = useMemo(() => {
    const id = editingPropertyId?.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id);
  }, [editorRevision, editingPropertyId, managerUserId]);

  const editingPropertyLabel = editingPropertyId
    ? (propertyOptions.find((o) => o.id === editingPropertyId)?.label ?? null)
    : null;
  const editorTitle = editingPropertyLabel ? `Edit lease · ${editingPropertyLabel}` : "Edit lease";

  const closeAll = () => {
    setSelectedId("");
    setEditingPropertyId(null);
    onClose();
  };

  const continueFromSelect = () => {
    if (!selectedId) {
      showToast("Choose a property.");
      return;
    }
    if (!managerUserId) {
      showToast("Sign in to edit leases.");
      return;
    }
    if (!resolveManagerListingSubmissionForPropertyId(managerUserId, selectedId)) {
      showToast("Could not load leases for that property.");
      return;
    }
    setEditingPropertyId(selectedId);
  };

  const onEditorClose = () => {
    setEditingPropertyId(null);
  };

  const syncedSub = resolved ? syncPropertyLeaseTemplatesFromListing(resolved.sub) : null;

  return (
    <>
      <Modal
        open={open && !editingPropertyId}
        title="Edit lease"
        onClose={closeAll}
        dense
        panelClassName="max-w-md"
        assistantContext="Edit lease"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="leases-edit-continue"
              disabled={!selectedId || propertyOptions.length === 0}
              onClick={continueFromSelect}
            >
              Continue
            </Button>
          </ModalFooter>
        }
      >
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions.map((option) => ({ id: option.id, label: option.label }))}
          propertyId={selectedId}
          onPropertyIdChange={setSelectedId}
        />
      </Modal>

      {resolved && managerUserId && syncedSub && editingPropertyId ? (
        <Modal
          open
          title={editorTitle}
          description="Add a lease or edit an existing template. Choose PropLane default (long or short term) or upload a PDF."
          onClose={onEditorClose}
          panelClassName="max-w-4xl"
          assistantContext="Edit lease"
        >
          <ManagerPropertyLeasePanel
            sub={syncedSub}
            saveTarget={resolved.saveTarget}
            managerUserId={managerUserId}
            propertyHint={editingPropertyLabel ? { buildingName: editingPropertyLabel } : undefined}
            propertyId={editingPropertyId}
            propertyLabel={editingPropertyLabel}
            onUpdated={() => {
              setEditorRevision((revision) => revision + 1);
              onSaved();
            }}
            showToast={showToast}
          />
        </Modal>
      ) : null}
    </>
  );
}
