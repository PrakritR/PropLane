"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyLeasePanel } from "@/components/portal/pro-property-lease-panel";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { syncPropertyLeaseTemplatesFromListing } from "@/lib/property-lease-template-sync";

/** Pick properties, then manage lease templates (single or bulk). */
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [editingPropertyIds, setEditingPropertyIds] = useState<string[]>([]);
  const [editorRevision, setEditorRevision] = useState(0);

  const allSelected = propertyOptions.length > 0 && selectedIds.size === propertyOptions.length;

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set());
      setEditingPropertyIds([]);
      setEditorRevision(0);
    }
  }, [open]);

  const resolved = useMemo(() => {
    const firstId = editingPropertyIds[0]?.trim();
    if (!firstId || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, firstId);
  }, [editorRevision, editingPropertyIds, managerUserId]);

  const editorTitle = useMemo(() => {
    if (editingPropertyIds.length === 1) {
      const label = propertyOptions.find((o) => o.id === editingPropertyIds[0])?.label ?? "Property";
      return `Edit lease · ${label}`;
    }
    if (editingPropertyIds.length > 1) {
      return `Edit lease · ${editingPropertyIds.length} properties`;
    }
    return "Edit lease";
  }, [editingPropertyIds, propertyOptions]);

  const closeAll = () => {
    setSelectedIds(new Set());
    setEditingPropertyIds([]);
    onClose();
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(propertyOptions.map((o) => o.id)) : new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const continueFromSelect = () => {
    if (selectedIds.size === 0) {
      showToast("Select at least one property.");
      return;
    }
    if (!managerUserId) {
      showToast("Sign in to edit lease settings.");
      return;
    }
    const ids = [...selectedIds];
    const firstHit = resolveManagerListingSubmissionForPropertyId(managerUserId, ids[0]!);
    if (!firstHit) {
      showToast("Could not load lease settings for the selected properties.");
      return;
    }
    setEditingPropertyIds(ids);
  };

  const onEditorClose = () => {
    setEditingPropertyIds([]);
  };

  const syncedSub = resolved ? syncPropertyLeaseTemplatesFromListing(resolved.sub) : null;
  const isBulkEdit = editingPropertyIds.length > 1;
  const primaryPropertyId = editingPropertyIds[0] ?? null;
  const primaryPropertyLabel = primaryPropertyId
    ? propertyOptions.find((o) => o.id === primaryPropertyId)?.label
    : null;

  return (
    <>
      <Modal
        open={open && editingPropertyIds.length === 0}
        title="Edit lease settings"
        description="Choose which properties' lease templates you want to edit. When you select multiple, the same lease settings apply to all."
        onClose={closeAll}
        dense
        panelClassName="max-w-md"
        assistantContext="Edit lease settings"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="leases-edit-continue"
              disabled={selectedIds.size === 0 || propertyOptions.length === 0}
              onClick={continueFromSelect}
            >
              Continue
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-accent/20 px-3 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary"
              data-attr="leases-edit-all-properties"
              checked={allSelected}
              disabled={propertyOptions.length === 0}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            <span className="text-sm font-semibold text-foreground">All properties</span>
          </label>

          <div className="max-h-[min(40vh,16rem)] space-y-1 overflow-y-auto rounded-xl border border-border p-2">
            {propertyOptions.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted">No properties in portfolio yet.</p>
            ) : (
              propertyOptions.map((o) => (
                <label
                  key={o.id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/30"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 rounded border-border text-primary"
                    data-attr={`leases-edit-property-${o.id}`}
                    checked={selectedIds.has(o.id)}
                    onChange={(e) => toggleOne(o.id, e.target.checked)}
                  />
                  <span className="min-w-0 text-sm text-foreground">{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      </Modal>

      {resolved && managerUserId && syncedSub && editingPropertyIds.length > 0 ? (
        <Modal
          open
          title={editorTitle}
          description={
            isBulkEdit
              ? "These settings apply to all selected properties. Add a lease or edit an existing template."
              : "Add a lease or edit an existing template. Choose PropLane default (long or short term) or upload a PDF."
          }
          onClose={onEditorClose}
          panelClassName="max-w-4xl"
          assistantContext="Edit lease"
        >
          <ManagerPropertyLeasePanel
            sub={syncedSub}
            saveTarget={resolved.saveTarget}
            managerUserId={managerUserId}
            propertyIds={isBulkEdit ? editingPropertyIds : undefined}
            propertyHint={primaryPropertyLabel ? { buildingName: primaryPropertyLabel } : undefined}
            propertyId={primaryPropertyId}
            propertyLabel={primaryPropertyLabel}
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
