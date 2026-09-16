"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ManagerSettingsPropertyField } from "@/components/portal/pro-portal-settings-panels";
import { ManagerPropertyApplicationQuestionsPanel } from "@/components/portal/pro-property-application-questions-panel";
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
