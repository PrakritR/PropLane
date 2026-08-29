"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/manager-application-questions-editor-modal";
import {
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import {
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applicationConfigFieldsFromSubmission,
  persistManagerListingSubmission,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import {
  readPropertyApplicationTemplates,
  removePropertyApplicationTemplate,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  addApplicationTemplateFromSeed,
  availableApplicationTemplateSeeds,
  submissionAfterRemovingApplicationTemplate,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import { PropertyTemplatePresetList } from "@/components/portal/property-template-preset-list";
import {
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
} from "@/components/portal/portal-list-add-row";
import { formatApplicationLeaseTermsLabel } from "@/lib/property-lease-template-sync";
import { normalizePropertyApplicationTemplateLabel } from "@/lib/property-application-template-sync";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

type QuestionsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

/** Property id the in-portal application preview wizard can bind to. */
export function resolveApplicationPreviewPropertyId(input: {
  listingId?: string | null;
  saveTarget?: QuestionsSaveTarget;
  managerUserId?: string | null;
  bulkPropertyIds?: string[];
}): string {
  const explicit = input.listingId?.trim();
  if (explicit) return explicit;
  const fromSaveTarget = input.saveTarget?.saveId.trim();
  if (fromSaveTarget) return fromSaveTarget;
  const managerUserId = input.managerUserId?.trim();
  const bulkIds = input.bulkPropertyIds?.map((id) => id.trim()).filter(Boolean) ?? [];
  if (!managerUserId || bulkIds.length === 0) return "";
  for (const propertyId of bulkIds) {
    const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
    if (hit?.saveTarget.saveId.trim()) return hit.saveTarget.saveId.trim();
  }
  return "";
}

/**
 * Per-property application templates — same list chrome as the lease tab.
 */
export function ManagerPropertyApplicationQuestionsPanel({
  sub,
  saveTarget,
  managerUserId,
  propertyIds,
  listingId,
  onUpdated,
  showToast,
  onRegisterAddApplication,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: QuestionsSaveTarget;
  managerUserId: string | null;
  /** When set, template changes apply to every listed property (bulk edit). */
  propertyIds?: string[];
  /** Live listing id — used for the in-portal application preview. */
  listingId?: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onRegisterAddApplication?: (openAdd: (() => void) | null) => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("edit");
  const [editingTemplate, setEditingTemplate] = useState<PropertyApplicationTemplate | null>(null);
  const syncedSub = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(syncedSub), [syncedSub]);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(templates.length);

  const bulkPropertyIds = propertyIds?.filter((id) => id.trim()) ?? [];

  const persistSubmission = useCallback(
    (merged: ManagerListingSubmissionV1, opts: { message: string }) => {
      if (!managerUserId) return false;

      if (bulkPropertyIds.length > 0) {
        const configFields = applicationConfigFieldsFromSubmission(merged);
        const nextTemplates = readPropertyApplicationTemplates(merged);
        let saved = 0;
        let failed = 0;
        for (const propertyId of bulkPropertyIds) {
          const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
          if (!hit) {
            failed += 1;
            continue;
          }
          const base = hit.sub.propertyApplicationTemplatesExplicit
          ? hit.sub
          : syncPropertyApplicationTemplatesFromListing(hit.sub);
        const next = withPropertyApplicationTemplatesExplicit(
          { ...base, ...configFields },
          nextTemplates,
        );
          if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) saved += 1;
          else failed += 1;
        }
        if (saved === 0) {
          showToast("Could not save application settings.");
          return false;
        }
        if (failed > 0) {
          showToast(`Updated application for ${saved} properties (${failed} could not be saved).`);
        } else if (saved > 1) {
          showToast(`Updated application for ${saved} properties.`);
        } else {
          showToast(opts.message);
        }
        return true;
      }

      if (!saveTarget) return false;
      if (!persistManagerListingSubmission(saveTarget, managerUserId, merged)) {
        showToast("Could not save application settings.");
        return false;
      }
      showToast(opts.message);
      return true;
    },
    [bulkPropertyIds, managerUserId, saveTarget, showToast],
  );

  const persistRemoval = (nextTemplates: PropertyApplicationTemplate[]) => {
    if (!managerUserId) return false;

    if (bulkPropertyIds.length > 0) {
      let saved = 0;
      let failed = 0;
      for (const propertyId of bulkPropertyIds) {
        const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
        if (!hit) {
          failed += 1;
          continue;
        }
        const base = hit.sub.propertyApplicationTemplatesExplicit
          ? hit.sub
          : syncPropertyApplicationTemplatesFromListing(hit.sub);
        const persisted = persistManagerListingSubmission(
          hit.saveTarget,
          managerUserId,
          submissionAfterRemovingApplicationTemplate(base, nextTemplates),
        );
        if (persisted) saved += 1;
        else failed += 1;
      }
      return saved > 0;
    }

    if (!saveTarget) return false;
    return persistManagerListingSubmission(
      saveTarget,
      managerUserId,
      submissionAfterRemovingApplicationTemplate(
        sub.propertyApplicationTemplatesExplicit ? sub : syncedSub,
        nextTemplates,
      ),
    );
  };

  /**
   * PropLane defaults this property does not carry. Deleting an application
   * sets `propertyApplicationTemplatesExplicit`, which permanently stops
   * auto-seeding — so without this list a removed default is unrecoverable.
   */
  const availableSeeds = useMemo(() => availableApplicationTemplateSeeds(syncedSub), [syncedSub]);

  const addSeedTemplate = useCallback(
    (seedKey: string) => {
      if (!managerUserId) return;

      if (bulkPropertyIds.length > 0) {
        let saved = 0;
        let failed = 0;
        let skipped = 0;
        for (const propertyId of bulkPropertyIds) {
          const hit = resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
          if (!hit) {
            failed += 1;
            continue;
          }
          // Resolve and write EACH property from its own submission, so a bulk
          // add never stamps this property's list onto the others.
          const base = hit.sub.propertyApplicationTemplatesExplicit
            ? hit.sub
            : syncPropertyApplicationTemplatesFromListing(hit.sub);
          const next = addApplicationTemplateFromSeed(base, seedKey as never);
          if (next === base) {
            skipped += 1;
            continue;
          }
          if (persistManagerListingSubmission(hit.saveTarget, managerUserId, next)) saved += 1;
          else failed += 1;
        }
        if (saved === 0) {
          showToast(
            skipped > 0 && failed === 0
              ? "That application is already on every selected property."
              : "Could not add application.",
          );
          return;
        }
        showToast(
          failed > 0
            ? `Added application on ${saved} properties (${failed} could not be saved).`
            : skipped > 0
              ? `Added application on ${saved} properties (${skipped} already had it).`
              : `Added application on ${saved} propert${saved === 1 ? "y" : "ies"}.`,
        );
        onUpdated();
        return;
      }

      if (!saveTarget) return;
      const base = sub.propertyApplicationTemplatesExplicit ? sub : syncedSub;
      const next = addApplicationTemplateFromSeed(base, seedKey as never);
      if (next === base) {
        showToast("That application is already on this property.");
        return;
      }
      const label = availableSeeds.find((s) => s.seedKey === seedKey)?.label ?? "Application";
      if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
        showToast("Could not add application.");
        return;
      }
      showToast(`${label} added.`);
      onUpdated();
    },
    [availableSeeds, bulkPropertyIds, managerUserId, onUpdated, saveTarget, showToast, sub, syncedSub],
  );

  const openAdd = useCallback(() => {
    setEditorMode("add");
    setEditingTemplate(null);
    setEditorOpen(true);
  }, []);

  useEffect(() => {
    onRegisterAddApplication?.(openAdd);
    return () => onRegisterAddApplication?.(null);
  }, [onRegisterAddApplication, openAdd]);

  const openEditApplication = (template: PropertyApplicationTemplate) => {
    setEditorMode("edit");
    setEditingTemplate(template);
    setEditorOpen(true);
  };

  const handleDeleteTemplate = (templateId: string) => {
    const next = removePropertyApplicationTemplate(templates, templateId);
    const persisted = persistRemoval(next);
    if (!persisted) {
      showToast("Could not delete application.");
      return;
    }
    setEditorOpen(false);
    setEditingTemplate(null);
    onUpdated();
    showToast("Application deleted.");
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingTemplate(null);
  };

  const selectedTemplates = useMemo(
    () => templates.filter((template) => selectedIds.has(template.id)),
    [selectedIds, templates],
  );

  const bulkDeleteTemplates = () => {
    if (selectedTemplates.length === 0) return;
    if (
      !window.confirm(
        `Delete ${selectedTemplates.length} application template${selectedTemplates.length === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    let next = templates;
    for (const template of selectedTemplates) {
      next = removePropertyApplicationTemplate(next, template.id);
    }
    const persisted = persistRemoval(next);
    if (!persisted) {
      showToast("Could not delete application.");
      return;
    }
    clearSelection();
    setEditorOpen(false);
    setEditingTemplate(null);
    onUpdated();
    showToast(
      selectedTemplates.length === 1 ? "Application deleted." : `${selectedTemplates.length} applications deleted.`,
    );
  };

  if (!managerUserId || (!saveTarget && bulkPropertyIds.length === 0)) return null;

  const editorTitle = editorMode === "add" ? "Add application" : "Edit application";

  return (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {templates.map((template) => (
          <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={selectedIds.has(template.id)}
                data-attr={`application-select-${template.id}`}
                onChange={() => toggleSelected(template.id)}
                onClick={(e) => e.stopPropagation()}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {normalizePropertyApplicationTemplateLabel(template.label)}
                </p>
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

      {/* PropLane defaults first — same as Lease and Requests. */}
      {availableSeeds.length > 0 ? (
        <div className="px-3 py-4 max-md:px-2.5 sm:py-5">
          <PropertyTemplatePresetList
            title="Add an application"
            dataAttr="property-application-template-suggestions"
            addDataAttrPrefix="property-application-seed-add"
            presets={availableSeeds.map((seed) => ({
              key: seed.seedKey,
              label: seed.label,
              subtitle:
                [
                  "PropLane default application",
                  formatApplicationLeaseTermsLabel(seed.applicationLeaseTerms)
                    ? `Applicants: ${formatApplicationLeaseTermsLabel(seed.applicationLeaseTerms)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
            }))}
            onAdd={addSeedTemplate}
          />
        </div>
      ) : null}

      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          ariaLabel="Add application"
          icon={PORTAL_LIST_ADD_ICONS.application}
          onClick={openAdd}
          dataAttr="property-application-add"
        />
      </div>

      {editorOpen ? (
        <ManagerApplicationQuestionsEditorModal
          open
          title={editorTitle}
          sub={syncedSub}
          saveTarget={saveTarget ?? undefined}
          propertyIds={bulkPropertyIds.length > 0 ? bulkPropertyIds : undefined}
          managerUserId={managerUserId}
          initialVariant={editingTemplate?.formVariant ?? "standard"}
          lockVariant={Boolean(editingTemplate)}
          templateEditorMode={editorMode}
          applicationTemplate={editingTemplate}
          templates={templates}
          onPersistSubmission={persistSubmission}
          canDelete={editorMode === "edit"}
          onDelete={
            editingTemplate
              ? () => handleDeleteTemplate(editingTemplate.id)
              : undefined
          }
          onClose={closeEditor}
          onSaved={onUpdated}
          showToast={showToast}
        />
      ) : null}

      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            {selectedIds.size === 1 && selectedTemplates[0] ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="property-application-bulk-edit"
                onClick={() => openEditApplication(selectedTemplates[0]!)}
              >
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
              data-attr="property-application-bulk-delete"
              onClick={bulkDeleteTemplates}
            >
              Delete
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
