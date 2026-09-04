"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import { ManagerSettingsPropertyField } from "@/components/portal/pro-portal-settings-panels";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";

/**
 * Pick ONE property, then manage its lease templates.
 *
 * The property dropdown is the same one Leases settings uses, on the same page
 * as the leases it filters — no Continue step. These two open from adjacent
 * buttons, so asking the same question two different ways reads as two
 * unrelated features.
 *
 * It was a multi-select ("apply to all") behind a Continue before. A single
 * property is the captain's call, and it also removes the quiet hazard of one
 * Save rewriting the lease templates of every house at once.
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
  const [selectedId, setSelectedId] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  /** The lease panel's own selection action, rendered in this modal's footer. */
  const [bulkActions, setBulkActions] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId("");
      setEditorRevision(0);
      setBulkActions(null);
    }
  }, [open]);

  // Open on the first property rather than an empty Select. The dialog's job is
  // to show leases; opening on "choose a property to see them" makes the
  // manager spend a click before the dialog does anything, and with one
  // property in the portfolio it is a click with a single possible answer.
  useEffect(() => {
    if (open && !selectedId && propertyOptions.length > 0) {
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
  const title = selectedLabel ? `Edit lease · ${selectedLabel}` : "Edit lease";

  const closeAll = () => {
    setSelectedId("");
    setBulkActions(null);
    onClose();
  };

  const syncedSub = resolved ? syncPropertyLeaseTemplatesFromListing(resolved.sub) : null;

  return (
    <Modal
      open={open}
      title={title}
      description="Choose a property, then add a lease or edit one of its templates."
      onClose={closeAll}
      panelClassName="max-w-4xl"
      assistantContext="Edit lease"
      footer={bulkActions ? <ModalFooter className="w-full">{bulkActions}</ModalFooter> : undefined}
    >
      <div className="space-y-4">
        <ManagerSettingsPropertyField
          propertyOptions={propertyOptions.map((option) => ({ id: option.id, label: option.label }))}
          propertyId={selectedId}
          onPropertyIdChange={setSelectedId}
        />

        {!selectedId ? (
          <p className="text-sm text-muted">Choose a property to see its leases.</p>
        ) : !resolved || !managerUserId || !syncedSub ? (
          <p className="text-sm text-muted">Could not load leases for that property.</p>
        ) : (
          <ManagerPropertyLeasePanel
            key={selectedId}
            sub={syncedSub}
            saveTarget={resolved.saveTarget}
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
    </Modal>
  );
}
