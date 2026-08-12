"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import {
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
} from "@/components/portal/portal-list-add-row";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import {
  propertyLeaseTemplateDraftFromTemplate,
  resolvePropertyLeaseEditHtml,
} from "@/lib/property-lease-edit";
import type { PropertyLeasePreviewHint } from "@/lib/property-lease-preview";
import {
  addLeaseTemplateFromSeed,
  availableLeaseTemplateSeeds,
  formatApplicationLeaseTermsLabel,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { PropertyLeaseTemplateSuggestions } from "@/components/portal/property-lease-template-suggestions";
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
  sectionActions,
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
  sectionActions?: ReactNode;
  /** Parent header "Add lease" — same handler as the dashed list footer row. */
  onRegisterAddLease?: (openAdd: (() => void) | null) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<PropertyLeaseTemplate | null>(null);

  const syncedSub = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const availableSeeds = useMemo(() => availableLeaseTemplateSeeds(syncedSub), [syncedSub]);

  const bulkPropertyIds = propertyIds?.filter((id) => id.trim()) ?? [];

  const persistSubmission = (nextSub: ManagerListingSubmissionV1, successMessage: string) => {
    if (!managerUserId) return false;
    if (!saveTarget) return false;
    if (!persistManagerListingSubmission(saveTarget, managerUserId, nextSub)) {
      showToast("Could not save lease settings.");
      return false;
    }
    showToast(successMessage);
    return true;
  };

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
    setFormMode("add");
    setEditingTemplateId(null);
    setFormOpen(true);
  }, []);

  const addSeedTemplate = useCallback(
    (seedKey: PropertyLeaseListingSeedKey) => {
      if (bulkPropertyIds.length > 0) {
        let saved = 0;
        let failed = 0;
        let skipped = 0;
        for (const bulkPropertyId of bulkPropertyIds) {
          const hit = resolveManagerListingSubmissionForPropertyId(managerUserId!, bulkPropertyId);
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
          if (persistManagerListingSubmission(hit.saveTarget, managerUserId!, nextSub)) saved += 1;
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
          showToast(`${seedLabel} added.`);
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

  const openLeasePreview = (template: PropertyLeaseTemplate) => {
    setPreviewTemplate(template);
    setPreviewOpen(true);
  };

  const previewHtml = useMemo(() => {
    if (!previewTemplate) return "";
    const override = previewTemplate.leaseTemplateHtmlOverride?.trim();
    if (override) return stripDisclosureReviewFromLeaseHtml(override);
    const source = propertyLeaseSourceFromTemplate(previewTemplate);
    const html = resolvePropertyLeaseEditHtml({
      sub: syncedSub,
      draft: propertyLeaseTemplateDraftFromTemplate(previewTemplate),
      source,
      templateKind: previewTemplate.kind,
      hint: propertyHint,
      demo: demoMode,
    });
    return stripDisclosureReviewFromLeaseHtml(html);
  }, [previewTemplate, syncedSub, propertyHint, demoMode]);

  const handleDelete = (templateId: string) => {
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

  return (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
          {sectionActions}
          {templates.map((template) => (
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
              <div className="flex shrink-0 flex-nowrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                  data-attr={`property-lease-view-${template.id}`}
                  onClick={() => openLeasePreview(template)}
                >
                  View
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                  data-attr={`property-lease-edit-${template.id}`}
                  onClick={() => openEdit(template.id)}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))}
      </PortalPropertyDetailSection>

      {availableSeeds.length > 0 || templates.length === 0 ? (
        <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
          <PropertyLeaseTemplateSuggestions
            seeds={availableSeeds}
            onAddSeed={addSeedTemplate}
            onAddCustom={openAdd}
          />
        </div>
      ) : (
        <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
          <PortalListAddRow
            label="Add custom lease"
            icon={PORTAL_LIST_ADD_ICONS.lease}
            onClick={openAdd}
            dataAttr="property-lease-add"
          />
        </div>
      )}

      <Modal
        open={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewTemplate(null);
        }}
        title={
          previewTemplate ? `View · ${previewTemplate.label}` : "View"
        }
        presentation="dialog"
        dense
        assistantStrip={false}
        stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
        panelClassName="flex max-h-[min(90vh,56rem)] w-full max-w-5xl flex-col"
        dataAttr="property-lease-preview"
      >
        {previewOpen && previewTemplate ? (
          <div className="mx-auto w-full max-w-5xl min-h-0 flex-1">
            {previewHtml ? (
              <iframe
                title={`Lease preview · ${previewTemplate.label}`}
                srcDoc={previewHtml}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                className="h-[min(72vh,52rem)] w-full rounded-xl border border-border bg-card"
              />
            ) : (
              <p className="rounded-xl border border-border bg-accent/20 px-3 py-2.5 text-sm text-muted">
                No preview yet — open Edit to upload or configure this lease.
              </p>
            )}
          </div>
        ) : null}
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
    </>
  );
}
