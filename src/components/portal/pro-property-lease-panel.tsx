"use client";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { Check, CreditCard, FileUp, FileText, AlertTriangle, Plus } from "lucide-react";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import {
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { PropertyFormAutomationCommandBar } from "@/components/portal/property-form-automation-chrome";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
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
  buildLeaseTemplateSeeds,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import type { PropertyLeaseListingSeedKey } from "@/lib/property-lease-templates";
import {
  propertyLeaseSourceFromTemplate,
  readPropertyLeaseTemplates,
  removePropertyLeaseTemplate,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import { ManagerLeaseQuestionsEditorModal } from "@/components/portal/pro-lease-questions-editor-modal";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { formatFeeCentsForFact } from "@/lib/property-form-row-facts";

type LeaseSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;


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
  const router = useRouter();
  const [pane, setPane] = useState<"form" | "automation">("form");
  const [leaseKindFilter, setLeaseKindFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [questionsEditorTemplate, setQuestionsEditorTemplate] = useState<PropertyLeaseTemplate | null>(null);
  const [autoImportFile, setAutoImportFile] = useState<File | null>(null);

  const syncedSub = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const visibleTemplates = useMemo(() => {
    if (!leaseKindFilter) return templates;
    return templates.filter((template) => template.kind === leaseKindFilter);
  }, [leaseKindFilter, templates]);
  const embedInModal = Boolean(onBulkActionsChange);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(templates.length);

  const bulkPropertyIds = useMemo(
    () => propertyIds?.filter((id) => id.trim()) ?? [],
    [propertyIds],
  );

  // `settingsPropertyLabel` no longer resolves a local automation sheet (C228)
  // — kept as a prop so callers need no change, just unused here.
  void settingsPropertyLabel;

  // P006/P009/P011: this property's pipeline order, lease signing fee and
  // default lease template — same per-property override
  // (`leasing-pipeline-preferences.ts`) the application panel reads, so the
  // two forms can never disagree about "who signs first".
  const rowFactPropertyId =
    settingsPropertyId ?? propertyId ?? (bulkPropertyIds.length === 0 ? saveTarget?.saveId ?? null : null);
  const formSetup = usePropertyFormSetupSettings(rowFactPropertyId);

  // P004/P006/P007: one row per lease type the LISTING offers (Long-term,
  // Short-term, Airbnb when allowed) — a type with no lease yet gets a plain
  // "No lease yet" placeholder with its own +, rather than a generic
  // Add-lease footer.
  const offeredSeeds = useMemo(() => buildLeaseTemplateSeeds(syncedSub), [syncedSub]);

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

  const openEdit = useCallback(
    (templateId: string) => {
      // An imported lease (C282) has its own question-config editor; every
      // other lease keeps the standard terms/document form.
      const target = templates.find((t) => t.id === templateId);
      if (target?.draftQuestionConfig || target?.publishedQuestionConfig) {
        setQuestionsEditorTemplate(target);
        return;
      }
      setFormMode("edit");
      setEditingTemplateId(templateId);
      setFormOpen(true);
    },
    [templates],
  );

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

  const formFilterSheet = !embedInModal ? (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([leaseKindFilter])}
      compactPanel
      commandStripTrigger
      dropdownAlign="start"
      filterFieldCount={1}
      mobileFlushBody
      onReset={() => setLeaseKindFilter("")}
      dataAttr="property-lease-filter-sheet-open"
    >
      <PortalFormSingleSelect
        label="Lease"
        value={leaseKindFilter}
        onChange={setLeaseKindFilter}
        options={[
          { value: "", label: "All leases" },
          { value: "long-term", label: "Long-term" },
          { value: "short-term", label: "Short-term" },
          { value: "time-based", label: "Time-based" },
          { value: "custom", label: "Custom" },
        ]}
        placeholder="All leases"
        dataAttr="property-lease-filter-kind"
      />
    </PortalFilterSortSheet>
  ) : null;

  const renderLeaseTemplateRow = (template: PropertyLeaseTemplate, typeLabel?: string | null) => {
    const isDefault = Boolean(
      formSetup.loaded &&
        formSetup.leasingPipeline.defaultLeaseTemplateId &&
        formSetup.leasingPipeline.defaultLeaseTemplateId === template.id,
    );
    const feeCents = formSetup.loaded ? formSetup.leasingPipeline.leaseSigningFeeCents : null;
    return (
      <div key={template.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <RowSelectCheckbox
            aria-label={`Select ${template.label}`}
            checked={selectedIds.has(template.id)}
            data-attr={`property-lease-select-${template.id}`}
            onChange={() => toggleSelected(template.id)}
            onClick={(event) => event.stopPropagation()}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{template.label}</p>
            {formSetup.loaded ? (
              <p
                className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted"
                data-attr="property-lease-row-facts"
              >
                {typeLabel ? (
                  <PortalRowFact icon={FileText} srLabel="Lease type">
                    {typeLabel}
                  </PortalRowFact>
                ) : null}
                {isDefault ? (
                  <PortalRowFact icon={Check} srLabel="Default">
                    Default
                  </PortalRowFact>
                ) : null}
                <PortalRowFact icon={CreditCard} srLabel="Lease fee">
                  {feeCents != null && feeCents > 0 ? `${formatFeeCentsForFact(feeCents)} lease fee` : "No lease fee"}
                </PortalRowFact>
                {template.leaseTemplateDocName ? (
                  <PortalRowFact icon={FileUp} srLabel="Source">
                    From {template.leaseTemplateDocName}
                  </PortalRowFact>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const emptyLeaseTypeRow = (key: string, label: string, onAdd: () => void, dataAttr: string) => (
    <div key={key} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS} data-attr={`property-lease-empty-type-${dataAttr}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/40 text-muted">
          <FileText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-muted">{label}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> No lease yet
          </p>
        </div>
      </div>
      <button
        type="button"
        className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-foreground"
        title={`Add ${label}`}
        aria-label={`Add ${label}`}
        data-attr={`property-lease-add-type-${dataAttr}`}
        onClick={onAdd}
      >
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );

  const seedTypeLabel = (seedKey: PropertyLeaseListingSeedKey | undefined): string | null => {
    if (seedKey === "primary") return "Long-term";
    if (seedKey === "short-term") return "Short-term";
    if (seedKey === "airbnb") return "Airbnb";
    return null;
  };

  const hasCustomTemplate = templates.some((t) => t.kind === "custom");

  const catalogBody = (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {offeredSeeds.flatMap((seed) => {
          const rowsForSeed = visibleTemplates.filter((t) => t.listingSeedKey === seed.seedKey);
          if (rowsForSeed.length > 0) {
            return rowsForSeed.map((template) => renderLeaseTemplateRow(template, seedTypeLabel(seed.seedKey)));
          }
          return [emptyLeaseTypeRow(seed.seedKey, seed.label, () => addSeedTemplate(seed.seedKey), seed.seedKey)];
        })}
        {!hasCustomTemplate ? emptyLeaseTypeRow("custom", "Custom lease", openAdd, "custom") : null}
        {visibleTemplates
          .filter((t) => !offeredSeeds.some((seed) => seed.seedKey === t.listingSeedKey))
          .map((template) => renderLeaseTemplateRow(template, seedTypeLabel(template.listingSeedKey)))}
      </PortalPropertyDetailSection>
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

      <ManagerLeaseQuestionsEditorModal
        key={questionsEditorTemplate?.id ?? "none"}
        open={Boolean(questionsEditorTemplate)}
        template={questionsEditorTemplate}
        templates={templates}
        propertyId={propertyId ?? bulkPropertyIds[0] ?? null}
        onClose={() => {
          setQuestionsEditorTemplate(null);
          setAutoImportFile(null);
        }}
        onSave={async (nextTemplates) => {
          const ok = await persistTemplates(nextTemplates);
          if (ok) onUpdated();
          return ok;
        }}
        onDelete={
          questionsEditorTemplate
            ? () => {
                handleDelete(questionsEditorTemplate.id);
                setQuestionsEditorTemplate(null);
              }
            : undefined
        }
        canDelete
        showToast={showToast}
        autoImportFile={autoImportFile}
        onAutoImportConsumed={() => setAutoImportFile(null)}
      />

    </>
  );

  // C228: the property page no longer carries its own lease automation
  // block. The gear now opens Settings -> Forms, where every lease's
  // Automation block lives (same workspace-scoped storage) alongside "Used at".
  const commandBar = !embedInModal ? (
    <PropertyFormAutomationCommandBar
      pane={pane}
      onPaneChange={setPane}
      panes={[{ id: "form", label: "Form" }]}
      filter={formFilterSheet}
      onSettings={() => router.push("/portal/profile?tab=forms")}
      settingsLabel="Lease automation"
      settingsDataAttr="property-lease-settings-open"
      onAdd={openAdd}
      addLabel="Add lease"
      addDataAttr="property-lease-command-add"
      activeFilterChips={
        leaseKindFilter ? (
          <PortalActiveFilterChips
            chips={[
              {
                id: "lease-kind",
                label:
                  leaseKindFilter === "short-term"
                    ? "Short-term"
                    : leaseKindFilter === "time-based"
                      ? "Time-based"
                      : leaseKindFilter === "custom"
                        ? "Custom"
                        : "Long-term",
                onRemove: () => setLeaseKindFilter(""),
              },
            ]}
          />
        ) : null
      }
    />
  ) : null;

  return (
    <>
      {commandBar}
      {embedInModal || pane === "form" ? (
      <PortalRecordListSurface className="mt-0 pb-0 max-lg:pb-0" onBulkClear={embedInModal ? undefined : clearSelection} bulkCount={selectedIds.size} bulkActions={!embedInModal && selectedTemplateId ? (
        <>
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
        </>
      ) : null}>{catalogBody}</PortalRecordListSurface>
      ) : null}

      {formModals}
    </>
  );
}
