"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
  PropertyDetailFooterActions,
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
  settingsPropertyId,
  settingsPropertyLabel,
  onUpdated,
  showToast,
  onRegisterAddApplication,
  embedInModal = false,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: QuestionsSaveTarget;
  managerUserId: string | null;
  /** When set, template changes apply to every listed property (bulk edit). */
  propertyIds?: string[];
  /** Live listing id — used for the in-portal application preview. */
  listingId?: string | null;
  /** Property record id for per-house application settings (promo code, auto-approve). */
  settingsPropertyId?: string | null;
  settingsPropertyLabel?: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onRegisterAddApplication?: (openAdd: (() => void) | null) => void;
  /** When true (Edit application modal), render the catalog inline without a nested list modal. */
  embedInModal?: boolean;
}) {
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("edit");
  const [editingTemplate, setEditingTemplate] = useState<PropertyApplicationTemplate | null>(null);
  const syncedSub = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(syncedSub), [syncedSub]);

  const bulkPropertyIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const settingsPropertyOptions = useMemo(() => {
    const id = settingsPropertyId?.trim();
    if (!id) return [];
    return [{ id, label: settingsPropertyLabel?.trim() || "This property" }];
  }, [settingsPropertyId, settingsPropertyLabel]);

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
    if (!embedInModal) setEditModalOpen(true);
    setEditorMode("add");
    setEditingTemplate(null);
    setEditorOpen(true);
  }, [embedInModal]);

  const openEditModal = useCallback(() => {
    setEditModalOpen(true);
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

  const editorTitle = editorMode === "add" ? "Add application" : "Edit application";

  if (!managerUserId || (!saveTarget && bulkPropertyIds.length === 0)) return null;

  const editorBody = (
    <>
      {templates.map((template) => (
        <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col items-start text-left"
            data-attr={`property-application-edit-${template.id}`}
            onClick={() => openEditApplication(template)}
          >
            <p className="text-sm font-semibold text-foreground">
              {normalizePropertyApplicationTemplateLabel(template.label)}
            </p>
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
    </>
  );

  if (embedInModal) {
    return (
      <>
        {editorBody}
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
              editingTemplate ? () => handleDeleteTemplate(editingTemplate.id) : undefined
            }
            onClose={closeEditor}
            onSaved={onUpdated}
            showToast={showToast}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <PortalPropertyDetailSection
        actions={
          <PropertyDetailFooterActions>
            <Button
              type="button"
              variant="outline"
              className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
              data-attr="property-application-edit-open"
              onClick={openEditModal}
            >
              Edit application
            </Button>
            {settingsPropertyOptions.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                data-attr="property-application-settings-open"
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
            No applications on this property yet. Use Edit application to add long-term, short-term, or
            co-signer forms.
          </p>
        ) : (
          templates.map((template) => (
            <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
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
            </div>
          ))
        )}
      </PortalPropertyDetailSection>

      <Modal
        open={editModalOpen}
        title="Edit application"
        description="Add or edit application forms for each stay type on this property."
        onClose={() => {
          setEditModalOpen(false);
          closeEditor();
        }}
        panelClassName="max-w-4xl"
        assistantContext="Edit application"
      >
        {editorBody}
      </Modal>

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

      {settingsPropertyOptions.length > 0 ? (
        <ProPortalSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialTab="applications"
          scoped
          scopedTitle="Application"
          propertyOptions={settingsPropertyOptions}
          initialPropertyId={settingsPropertyOptions[0]?.id}
        />
      ) : null}
    </>
  );
}
