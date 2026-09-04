"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ManagerPropertyRequestsPanel } from "@/components/portal/pro-property-requests-panel";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/** Pick one property, then edit its request-type catalog. */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setEditingPropertyId(null);
    }
  }, [open]);

  const resolved = useMemo(() => {
    void refreshTick;
    const id = editingPropertyId?.trim();
    if (!id || !managerUserId) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, id);
  }, [editingPropertyId, managerUserId, refreshTick]);

  const editorTitle = useMemo(() => {
    if (!editingPropertyId) return "Edit service types";
    const label = propertyOptions.find((o) => o.id === editingPropertyId)?.label ?? "Property";
    return `Edit service types · ${label}`;
  }, [editingPropertyId, propertyOptions]);

  const closeAll = () => {
    setSelectedId(null);
    setEditingPropertyId(null);
    onClose();
  };

  const continueFromSelect = () => {
    const id = selectedId?.trim();
    if (!id) {
      showToast("Select a property.");
      return;
    }
    if (!managerUserId) {
      showToast("Sign in to edit service types.");
      return;
    }
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, id);
    if (!hit) {
      showToast("Could not load request settings for this property.");
      return;
    }
    setEditingPropertyId(id);
  };

  const onEditorClose = () => {
    setEditingPropertyId(null);
  };

  const sub = resolved ? normalizeManagerListingSubmissionV1(resolved.sub) : null;

  const handleUpdated = () => {
    setRefreshTick((t) => t + 1);
    onSaved();
  };

  return (
    <>
      <Modal
        open={open && !editingPropertyId}
        title="Edit service types"
        description="Choose a property to edit its service types."
        onClose={closeAll}
        dense
        panelClassName="max-w-md"
        footer={
          <ModalFooter>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="services-edit-continue"
              disabled={!selectedId || propertyOptions.length === 0}
              onClick={continueFromSelect}
            >
              Continue
            </Button>
          </ModalFooter>
        }
      >
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
                  type="radio"
                  name="services-edit-property"
                  className="h-4 w-4 shrink-0"
                  data-attr={`services-edit-property-${o.id}`}
                  checked={selectedId === o.id}
                  onChange={() => setSelectedId(o.id)}
                />
                <span className="min-w-0 text-sm text-foreground">{o.label}</span>
              </label>
            ))
          )}
        </div>
      </Modal>

      {resolved && managerUserId && sub && editingPropertyId ? (
        <Modal
          open
          title={editorTitle}
          onClose={onEditorClose}
          panelClassName="max-w-4xl"
          dataAttr="services-edit-request-types"
        >
          <ManagerPropertyRequestsPanel
            key={editingPropertyId}
            sub={sub}
            saveTarget={resolved.saveTarget}
            managerUserId={managerUserId}
            onUpdated={handleUpdated}
            showToast={showToast}
          />
        </Modal>
      ) : null}
    </>
  );
}
