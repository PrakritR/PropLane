"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
  PropertyDetailFooterActions,
} from "@/components/portal/portal-property-detail-section";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { usePublishModalBulkActions } from "@/hooks/use-publish-modal-bulk-actions";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
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
  onBulkActionsChange,
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
  /**
   * When set (e.g. Edit lease modal), show the selectable catalog inline and
   * publish selection actions to the parent dialog footer.
   */
  onBulkActionsChange?: (actions: ReactNode | null) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  const syncedSub = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const availableSeeds = useMemo(() => availableLeaseTemplateSeeds(syncedSub), [syncedSub]);
  const embedInModal = Boolean(onBulkActionsChange);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(templates.length);

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
    async (nextSub: ManagerListingSubmissionV1, successMessage: string) => {
      if (!managerUserId || !saveTarget) return false;
      const ok = await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, nextSub);
      if (!ok) {
        showToast("Could not save lease settings.");
        return false;
      }
      showToast(successMessage);
      return true;
    },
    [managerUserId, saveTarget, showToast],
  );

  const persistTemplates = async (nextTemplates: PropertyLeaseTemplate[]) => {
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
        if (await persistManagerListingSubmissionOnServer(hit.saveTarget, managerUserId, next)) saved += 1;
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
    return persistManagerListingSubmissionOnServer(saveTarget, managerUserId, next);
  };

  const openAdd = useCallback(() => {
    setFormMode("add");
    setEditingTemplateId(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((templateId: string) => {
    setFormMode("edit");
    setEditingTemplateId(templateId);
    setFormOpen(true);
  }, []);

  const selectedTemplates = useMemo(
    () => templates.filter((template) => selectedIds.has(template.id)),
    [selectedIds, templates],
  );
  const selectedTemplateId = selectedIds.size === 1 ? selectedTemplates[0]?.id ?? null : null;

  const modalBulkActions = useMemo(() => {
    if (!selectedTemplateId) return null;
    const templateId = selectedTemplateId;
    return (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="property-lease-bulk-edit"
        onClick={() => openEdit(templateId)}
      >
        Edit lease
      </Button>
    );
  }, [openEdit, selectedTemplateId]);

  usePublishModalBulkActions(
    onBulkActionsChange,
    selectedTemplateId ?? "",
    modalBulkActions,
  );

  const addSeedTemplate = useCallback(
    (seedKey: PropertyLeaseListingSeedKey) => {
      void (async () => {
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
            if (await persistManagerListingSubmissionOnServer(hit.saveTarget, managerUserId, nextSub)) saved += 1;
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

        if (!saveTarget) {
          showToast("Could not add lease.");
          return;
        }
        const nextSub = addLeaseTemplateFromSeed(syncedSub, seedKey);
        if (nextSub === syncedSub) {
          showToast("That lease is already on this property.");
          return;
        }
        const seedLabel =
          availableLeaseTemplateSeeds(syncedSub).find((s) => s.seedKey === seedKey)?.label ?? "Lease";
        if (!(await persistSubmission(nextSub, `${seedLabel} added.`))) return;
        onUpdated();
      })();
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

  const deleteTemplateAcrossProperties = async (target: PropertyLeaseTemplate) => {
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
      if (await persistManagerListingSubmissionOnServer(hit.saveTarget, managerUserId, next)) saved += 1;
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

    void (async () => {
      if (bulkPropertyIds.length > 0) {
        if (!(await deleteTemplateAcrossProperties(target))) return;
        onUpdated();
        return;
      }

      const next = removePropertyLeaseTemplate(templates, templateId);
      if (!(await persistTemplates(next))) {
        showToast("Could not delete lease.");
        return;
      }
      onUpdated();
      showToast("Lease deleted.");
    })();
  };

  if (!managerUserId || (!saveTarget && bulkPropertyIds.length === 0)) return null;

  const editingTemplate = templates.find((t) => t.id === editingTemplateId) ?? null;

  const settingsFooter =
    !embedInModal && settingsPropertyOptions.length > 0 ? (
      <PropertyDetailFooterActions>
        <Button
          type="button"
          variant="outline"
          className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
          data-attr="property-lease-settings-open"
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </Button>
      </PropertyDetailFooterActions>
    ) : null;

  const catalogBody = (
    <>
      <PortalPropertyDetailSection
        contentClassName="space-y-0"
        actions={settingsFooter}
      >
        {templates.map((template) => (
          <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={selectedIds.has(template.id)}
                data-attr={`property-lease-select-${template.id}`}
                onChange={() => toggleSelected(template.id)}
                onClick={(event) => event.stopPropagation()}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{template.label}</p>
                <p className="mt-0.5 text-xs text-muted">{leaseDocumentSummary(template)}</p>
                {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms) ? (
                  <p className="mt-0.5 text-xs text-muted">
                    Applicants: {formatApplicationLeaseTermsLabel(template.applicationLeaseTerms)}
                  </p>
                ) : null}
              </div>
            </label>
          </div>
        ))}
      </PortalPropertyDetailSection>

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

  const formModals = (
    <>
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
          clearSelection();
        }}
        onAssistantRefresh={() => {
          void syncPropertyPipelineFromServer({ force: true }).then(() => onUpdated());
        }}
        onDelete={
          editingTemplateId ? () => handleDelete(editingTemplateId) : undefined
        }
        onSave={async (nextTemplates) => {
          if (!(await persistTemplates(nextTemplates))) {
            showToast("Could not save lease.");
            return false;
          }
          onUpdated();
          return true;
        }}
        showToast={showToast}
      />

      {settingsPropertyOptions.length > 0 ? (
        <ProPortalSettingsModal
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

  return (
    <>
      {catalogBody}
      {!embedInModal && selectedTemplateId ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="property-lease-bulk-edit"
              onClick={() => openEdit(selectedTemplateId)}
            >
              Edit lease
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
      {formModals}
    </>
  );
}
