"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
  PropertyDetailFooterActions,
} from "@/components/portal/portal-property-detail-section";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
  formatApplicationLeaseTermsLabel,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { PropertyLeaseTemplateSuggestions } from "@/components/portal/property-lease-template-suggestions";
import {
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
} from "@/components/portal/portal-list-add-row";
import type { PropertyLeaseListingSeedKey } from "@/lib/property-lease-templates";
import {
  propertyLeaseSourceFromTemplate,
  readPropertyLeaseTemplates,
  removePropertyLeaseTemplate,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import {
  documentModeFromLease,
  propertyLeaseDocumentModeLabel,
} from "@/lib/property-lease-source";

type LeaseSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function leaseDocumentSummary(template: PropertyLeaseTemplate): string {
  const source = propertyLeaseSourceFromTemplate(template);
  if (source === "custom_format") {
    return template.leaseTemplateDocName?.trim()
      ? `Uploaded · ${template.leaseTemplateDocName}`
      : "Uploaded PDF · not parsed yet";
  }
  return propertyLeaseDocumentModeLabel(documentModeFromLease(source, template.kind));
}

/**
 * "The same lease" across two properties.
 *
 * A bulk save writes the template array verbatim, so those rows share an id; a
 * bulk seed add mints a fresh id per property and only the `listingSeedKey`
 * matches. A bulk delete has to recognize both, and nothing else — matching
 * loosely (by label or kind) would delete a lease the manager never opened.
 */
function leaseTemplatesMatch(row: PropertyLeaseTemplate, target: PropertyLeaseTemplate): boolean {
  if (row.id === target.id) return true;
  return Boolean(target.listingSeedKey) && row.listingSeedKey === target.listingSeedKey;
}

/**
 * Per-property lease templates — PropLane default (long/short), upload, and inline format editor.
 */
export function ManagerPropertyLeasePanel({
  sub,
  saveTarget,
  managerUserId,
  propertyIds,
  onUpdated,
  showToast,
  propertyHint,
  propertyId,
  propertyLabel,
  demoMode = false,
  settingsPropertyId,
  settingsPropertyLabel,
  onRegisterAddLease,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: LeaseSaveTarget;
  managerUserId: string | null;
  /** When set, template changes apply to every listed property (bulk edit). */
  propertyIds?: string[];
  onUpdated: () => void;
  showToast: (m: string) => void;
  propertyHint?: PropertyLeasePreviewHint;
  propertyId?: string | null;
  propertyLabel?: string | null;
  demoMode?: boolean;
  /** Property record id for per-house lease automation settings. */
  settingsPropertyId?: string | null;
  settingsPropertyLabel?: string | null;
  /** Parent header "Add lease" — same handler as the dashed list footer row. */
  onRegisterAddLease?: (openAdd: (() => void) | null) => void;
}) {
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  const syncedSub = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const availableSeeds = useMemo(() => availableLeaseTemplateSeeds(syncedSub), [syncedSub]);

  const bulkPropertyIds = useMemo(
    () => propertyIds?.filter((id) => id.trim()) ?? [],
    [propertyIds],
  );

  const settingsPropertyOptions = useMemo(() => {
    const id = settingsPropertyId?.trim();
    if (!id) return [];
    return [{ id, label: settingsPropertyLabel?.trim() || "This property" }];
  }, [settingsPropertyId, settingsPropertyLabel]);

  const persistSubmission = useCallback(
    (nextSub: ManagerListingSubmissionV1, successMessage: string) => {
      if (!managerUserId || !saveTarget) return false;
      if (!persistManagerListingSubmission(saveTarget, managerUserId, nextSub)) {
        showToast("Could not save lease settings.");
        return false;
      }
      showToast(successMessage);
      return true;
    },
    [managerUserId, saveTarget, showToast],
  );

  const persistTemplates = (nextTemplates: PropertyLeaseTemplate[]) => {
    if (!managerUserId) return false;

    if (bulkPropertyIds.length > 0) {
      let saved = 0;
      let failed = 0;
      for (const bulkPropertyId of bulkPropertyIds) {
        const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, bulkPropertyId);
        if (!hit) {
          failed += 1;
          continue;
        }
        const base = syncPropertyLeaseTemplatesFromListing(hit.sub);
        const next = syncLegacyLeaseFieldsFromTemplates(base, nextTemplates);
        if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) saved += 1;
        else failed += 1;
      }
      if (saved === 0) {
        showToast("Could not save lease settings.");
        return false;
      }
      if (failed > 0) {
        showToast(`Updated lease for ${saved} properties (${failed} could not be saved).`);
      } else if (saved > 1) {
        showToast(`Updated lease for ${saved} properties.`);
      }
      return true;
    }

    if (!saveTarget) return false;
    const next = syncLegacyLeaseFieldsFromTemplates(syncedSub, nextTemplates);
    return persistManagerListingSubmission(saveTarget, managerUserId, next);
  };

  const openAdd = useCallback(() => {
    setEditModalOpen(true);
    setFormMode("add");
    setEditingTemplateId(null);
    setFormOpen(true);
  }, []);

  const openEditModal = useCallback(() => {
    setEditModalOpen(true);
  }, []);

  const addSeedTemplate = useCallback(
    (seedKey: PropertyLeaseListingSeedKey) => {
      if (bulkPropertyIds.length > 0) {
        if (!managerUserId) return;
        let saved = 0;
        let failed = 0;
        let skipped = 0;
        for (const bulkPropertyId of bulkPropertyIds) {
          const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, bulkPropertyId);
          if (!hit) {
            failed += 1;
            continue;
          }
          const base = syncPropertyLeaseTemplatesFromListing(hit.sub);
          const nextSub = addLeaseTemplateFromSeed(base, seedKey);
          if (nextSub === base) {
            skipped += 1;
            continue;
          }
          if (persistManagerListingSubmission(hit.saveTarget, managerUserId, nextSub)) saved += 1;
          else failed += 1;
        }
        if (saved === 0) {
          showToast(
            skipped > 0 && failed === 0
              ? "That lease is already on every selected property."
              : "Could not add lease.",
          );
          return;
        }
        if (failed > 0) {
          showToast(`Added lease on ${saved} properties (${failed} could not be saved).`);
        } else if (saved > 1) {
          showToast(`Added lease on ${saved} properties.`);
        } else {
          const seedLabel =
            availableLeaseTemplateSeeds(syncedSub).find((s) => s.seedKey === seedKey)?.label ??
            "Lease";
          showToast(
            skipped > 0
              ? `${seedLabel} added on ${saved} properties (${skipped} already had it).`
              : `${seedLabel} added.`,
          );
        }
        onUpdated();
        return;
      }

      if (!saveTarget) return;
      const nextSub = addLeaseTemplateFromSeed(syncedSub, seedKey);
      if (nextSub === syncedSub) {
        showToast("That lease is already on this property.");
        return;
      }
      const seedLabel =
        availableLeaseTemplateSeeds(syncedSub).find((s) => s.seedKey === seedKey)?.label ?? "Lease";
      if (!persistSubmission(nextSub, `${seedLabel} added.`)) return;
      onUpdated();
    },
    [
      bulkPropertyIds,
      managerUserId,
      onUpdated,
      persistSubmission,
      saveTarget,
      showToast,
      syncedSub,
    ],
  );

  useEffect(() => {
    onRegisterAddLease?.(openAdd);
    return () => onRegisterAddLease?.(null);
  }, [onRegisterAddLease, openAdd]);

  const openEdit = (templateId: string) => {
    setFormMode("edit");
    setEditingTemplateId(templateId);
    setFormOpen(true);
  };

  const deleteTemplateAcrossProperties = (target: PropertyLeaseTemplate) => {
    if (!managerUserId) return false;
    let saved = 0;
    let failed = 0;
    let skipped = 0;
    for (const bulkPropertyId of bulkPropertyIds) {
      const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, bulkPropertyId);
      if (!hit) {
        failed += 1;
        continue;
      }
      const base = syncPropertyLeaseTemplatesFromListing(hit.sub);
      const existing = readPropertyLeaseTemplates(base);
      const remaining = existing.filter((row) => !leaseTemplatesMatch(row, target));
      if (remaining.length === existing.length) {
        skipped += 1;
        continue;
      }
      const next = syncLegacyLeaseFieldsFromTemplates(base, remaining);
      if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) saved += 1;
      else failed += 1;
    }
    if (saved === 0) {
      showToast(
        skipped > 0 && failed === 0
          ? "That lease is not on the selected properties."
          : "Could not delete lease.",
      );
      return false;
    }
    if (failed > 0) {
      showToast(`Lease deleted on ${saved} properties (${failed} could not be saved).`);
    } else if (saved > 1) {
      showToast(`Lease deleted on ${saved} properties.`);
    } else {
      showToast(skipped > 0 ? `Lease deleted on ${saved} property.` : "Lease deleted.");
    }
    return true;
  };

  const handleDelete = (templateId: string) => {
    const target = templates.find((t) => t.id === templateId);
    if (!target) return;

    if (bulkPropertyIds.length > 0) {
      if (!deleteTemplateAcrossProperties(target)) return;
      onUpdated();
      return;
    }

    const next = removePropertyLeaseTemplate(templates, templateId);
    if (!persistTemplates(next)) {
      showToast("Could not delete lease.");
      return;
    }
    onUpdated();
    showToast("Lease deleted.");
  };

  if (!managerUserId || (!saveTarget && bulkPropertyIds.length === 0)) return null;

  const editingTemplate = templates.find((t) => t.id === editingTemplateId) ?? null;

  const editorBody = (
    <>
      {templates.map((template) => (
        <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col items-start text-left"
            data-attr={`property-lease-edit-${template.id}`}
            onClick={() => openEdit(template.id)}
          >
            <p className="text-sm font-semibold text-foreground">{template.label}</p>
            <p className="mt-0.5 text-xs text-muted">{leaseDocumentSummary(template)}</p>
            {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms) ? (
              <p className="mt-0.5 text-xs text-muted">
                Applicants: {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms)}
              </p>
            ) : null}
          </button>
        </div>
      ))}

      {availableSeeds.length > 0 ? (
        <div className="px-3 py-4 max-md:px-2.5 sm:py-5">
          <PropertyLeaseTemplateSuggestions seeds={availableSeeds} onAddSeed={addSeedTemplate} />
        </div>
      ) : null}

      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          ariaLabel="Add lease"
          icon={PORTAL_LIST_ADD_ICONS.lease}
          onClick={openAdd}
          dataAttr="property-lease-add"
        />
      </div>
    </>
  );

  return (
    <>
      <PortalPropertyDetailSection
        actions={
          <PropertyDetailFooterActions>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
              data-attr="property-lease-edit-open"
              onClick={openEditModal}
            >
              Edit lease
            </Button>
            {settingsPropertyOptions.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                data-attr="property-lease-settings-open"
                onClick={() => setSettingsOpen(true)}
              >
                Settings
              </Button>
            ) : null}
          </PropertyDetailFooterActions>
        }
      >
        {templates.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted max-md:px-2.5">
            No leases on this property yet. Use Edit lease to add long-term, short-term, or uploaded
            lease templates.
          </p>
        ) : (
          templates.map((template) => (
            <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{template.label}</p>
                <p className="mt-0.5 text-xs text-muted">{leaseDocumentSummary(template)}</p>
                {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms) ? (
                  <p className="mt-0.5 text-xs text-muted">
                    Applicants: {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms)}
                  </p>
                ) : null}
              </div>
            </div>
          ))
        )}
      </PortalPropertyDetailSection>

      <Modal
        open={editModalOpen}
        title="Edit lease"
        description="Add or edit lease templates for each stay type on this property."
        onClose={() => {
          setEditModalOpen(false);
          setFormOpen(false);
          setEditingTemplateId(null);
        }}
        panelClassName="max-w-4xl"
        assistantContext="Edit lease"
      >
        {editorBody}
      </Modal>

      <PropertyLeaseFormModal
        open={formOpen}
        mode={formMode}
        sub={sub}
        template={editingTemplate}
        templates={templates}
        propertyHint={propertyHint}
        propertyId={propertyId ?? bulkPropertyIds[0] ?? null}
        demoMode={demoMode}
        canDelete={formMode === "edit"}
        onClose={() => {
          setFormOpen(false);
          setEditingTemplateId(null);
        }}
        onAssistantRefresh={() => {
          void syncPropertyPipelineFromServer({ force: true }).then(() => onUpdated());
        }}
        onDelete={
          editingTemplateId
            ? () => handleDelete(editingTemplateId)
            : undefined
        }
        onSave={(nextTemplates) => {
          if (!persistTemplates(nextTemplates)) {
            showToast("Could not save lease.");
            return false;
          }
          onUpdated();
          return true;
        }}
        showToast={showToast}
      />

      {settingsPropertyOptions.length > 0 ? (
        <ManagerPortalSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialTab="lease"
          scoped
          scopedTitle="Lease"
          propertyOptions={settingsPropertyOptions}
          initialPropertyId={settingsPropertyOptions[0]?.id}
        />
      ) : null}
    </>
  );
}
