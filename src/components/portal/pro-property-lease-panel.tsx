"use client";
import {
  offeredStayTypeTerms,
  stayTypeLabelForLeaseKindDisplay,
  submissionWithLeaseTemplates,
  type LeaseOptionKey,
} from "@/lib/property-form-stay-type-routing";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { FileUp, FileText, AlertTriangle, Star } from "lucide-react";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PropertyLeaseTemplateInlinePreview } from "@/components/portal/property-lease-template-inline-preview";
import { PropertyFormTemplatePreviewModal } from "@/components/portal/property-form-template-preview-modal";
import {
  openPropertyFormTemplateInNewTab,
  readSoloPropertyFormTemplateId,
} from "@/components/portal/property-form-template-open-tab";
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
  availableLeaseTemplateSeeds,
  syncPropertyLeaseTemplatesFromListing,
} from "@/lib/property-lease-template-sync";
import { leasingPlusMenuEntries, type LeasingPlusMenuEntry } from "@/lib/leasing-plus-menu";
import { FormPromoCodesDialog } from "@/components/portal/form-promo-codes";
import { missingLeaseDefaults, submissionWithLeaseDefault } from "@/lib/leasing-quick-add";
import type { PropertyLeaseListingSeedKey } from "@/lib/property-lease-templates";
import {
  explicitDefaultLeaseForStay,
  leaseTemplateStay,
  propertyLeaseSourceFromTemplate,
  readPropertyLeaseTemplates,
  removePropertyLeaseTemplate,
  syncLegacyLeaseFieldsFromTemplates,
  withLeaseDefaultForStay,
  type LeaseStay,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import { stayCounts, stayTabItems, type PropertyStay } from "@/lib/property-stay-tabs";
import { ManagerLeaseQuestionsEditorModal } from "@/components/portal/pro-lease-questions-editor-modal";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { withPropertyApplicationTemplatesExplicit, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { useConfirm } from "@/components/providers/app-ui-provider";

/**
 * Rows the Lease tab draws: one per lease the property has. A PropLane default it does not carry is not a
 * placeholder row; it is a "Quick add" action under the list, so the header count is exactly the rows shown.
 */
export function leaseListRowCount(templates: ReadonlyArray<{ listingSeedKey?: string }>): number {
  return templates.length;
}

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
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const [pane, setPane] = useState<"form" | "automation">("form");
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const [leaseKindFilter, setLeaseKindFilter] = useState("");
  const [leaseSearch, setLeaseSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "edit">("add");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [pendingEditTemplateId, setPendingEditTemplateId] = useState<string | null>(null);
  const [questionsEditorTemplate, setQuestionsEditorTemplate] = useState<PropertyLeaseTemplate | null>(null);

  const syncedSub = useMemo(() => syncPropertyLeaseTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const embedInModal = Boolean(onBulkActionsChange);
  // Long-term leases · Short-term leases. The stay is derived from the lease's kind / routed terms. A stay the
  // property does not allow loses its tab unless it still holds a lease the manager owns (never hide data); an
  // untouched PropLane default the sync switched off for a stay the property does not offer (`stayHidden`) does
  // not count. The stay's default is a row inside its list (a Default fact + "Set as default").
  const [tab, setTab] = useState<PropertyStay>("long_term");
  const [addStay, setAddStay] = useState<LeaseStay | undefined>(undefined);
  const counted = useMemo(() => templates.filter((row) => !row.stayHidden), [templates]);
  const tabItems = useMemo(
    () =>
      stayTabItems(
        syncedSub,
        stayCounts(counted, (row) => leaseTemplateStay(row)),
        (stay) => (stay === "long_term" ? "Long-term leases" : "Short-term leases"),
      ).map((item) => ({ ...item, dataAttr: `property-lease-tab-${item.id}` })),
    [counted, syncedSub],
  );
  const activeTab: PropertyStay = tabItems.some((item) => item.id === tab) ? tab : tabItems[0]!.id;
  const activeStay: PropertyStay = activeTab;
  const tabAddStay: PropertyStay | undefined = embedInModal ? undefined : activeStay;
  const visibleTemplates = useMemo(() => {
    const q = leaseSearch.trim().toLowerCase();
    let rows = embedInModal ? counted : counted.filter((row) => leaseTemplateStay(row) === activeStay);
    if (leaseKindFilter) {
      rows = rows.filter((template) => template.kind === leaseKindFilter);
    }
    if (!q) return rows;
    return rows.filter((template) => {
      const label = template.label?.trim() || "Lease";
      return label.toLowerCase().includes(q);
    });
  }, [activeStay, counted, embedInModal, leaseKindFilter, leaseSearch]);
  // One row per lease type the listing offers (a type with no lease yet still
  // draws its "No lease yet" row), plus any lease outside those types — the
  // header count is exactly the rows the list shows.
  // Quick add offers only the starters for the open tab's stay (a long-term tab never offers a short-term lease,
  // and the Airbnb starter is short term). `missingLeaseDefaults` derives each starter's stay from the seed
  // itself, so a new seed can never land in the wrong tab.
  const missingDefaults = useMemo(
    () => missingLeaseDefaults(syncedSub, embedInModal ? undefined : activeStay),
    [activeStay, embedInModal, syncedSub],
  );
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
  // Short-term, Airbnb when allowed) — a type with no lease yet gets a
  // "No lease yet" row whose ⋯ adds the PropLane standard or a PDF.

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

  const persistTemplates = async (
    nextTemplates: PropertyLeaseTemplate[],
    extra?: Partial<Pick<ManagerListingSubmissionV1, "allowedLeaseTerms">>,
    applications?: PropertyApplicationTemplate[],
    touchedLeaseOptions?: LeaseOptionKey[],
  ) => {
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
        // Same as the single path, per property: "Allow custom dates" / "Allow month-to-month" change
        // only the touched terms of THIS listing's allowed terms (its other terms are its own).
        const next = submissionWithLeaseTemplates(base, nextTemplates, touchedLeaseOptions ?? []);
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
    const withLeases = { ...syncLegacyLeaseFieldsFromTemplates(syncedSub, nextTemplates), ...extra };
    // `applications` is the Used-for mapping's edit (application first, then lease).
    const next = applications ? withPropertyApplicationTemplatesExplicit(withLeases, applications) : withLeases;
    return persistManagerListingSubmissionOnServer(saveTarget, managerUserId, next);
  };

  const openAdd = useCallback(() => {
    setFormMode("add");
    setEditingTemplateId(null);
    setAddStay(tabAddStay);
    setFormOpen(true);
  }, [tabAddStay]);

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

  useEffect(() => {
    if (!pendingEditTemplateId) return;
    if (!templates.some((t) => t.id === pendingEditTemplateId)) return;
    setPendingEditTemplateId(null);
    openEdit(pendingEditTemplateId);
  }, [pendingEditTemplateId, templates, openEdit]);

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
    (seedKey: PropertyLeaseListingSeedKey, thenUpload = false) => {
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
            const nextSub = submissionWithLeaseDefault(base, seedKey);
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
        const nextSub = submissionWithLeaseDefault(syncedSub, seedKey);
        if (nextSub === syncedSub) {
          showToast("That lease is already on this property.");
          return;
        }
        const seedLabel =
          availableLeaseTemplateSeeds(syncedSub).find((s) => s.seedKey === seedKey)?.label ?? "Lease";
        if (!(await persistSubmission(nextSub, `${seedLabel} added.`))) return;
        onUpdated();
        // "Upload a PDF": the new lease opens in the lease form, whose document
        // step takes the PDF — once the saved listing carries the new row.
        if (thenUpload) {
          const created = readPropertyLeaseTemplates(syncPropertyLeaseTemplatesFromListing(nextSub)).find(
            (row) => row.listingSeedKey === seedKey,
          );
          if (created) setPendingEditTemplateId(created.id);
        }
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

  const duplicateTemplate = async (template: PropertyLeaseTemplate) => {
    const copy = createPropertyLeaseTemplate({
      kind: template.kind,
      label: `${template.label} copy`,
      source: propertyLeaseSourceFromTemplate(template),
      customLeaseTerms: template.customLeaseTerms,
      leaseTemplateDocUrl: template.leaseTemplateDocUrl,
      leaseTemplateDocName: template.leaseTemplateDocName,
      applicationLeaseTerms: template.applicationLeaseTerms,
    });
    const duplicate: PropertyLeaseTemplate = {
      ...template,
      ...copy,
      leaseTemplateHtmlOverride: template.leaseTemplateHtmlOverride,
      draftQuestionConfig: template.draftQuestionConfig ? structuredClone(template.draftQuestionConfig) : undefined,
      publishedQuestionConfig: template.publishedQuestionConfig ? structuredClone(template.publishedQuestionConfig) : undefined,
      leaseTemplateImportReview: template.leaseTemplateImportReview ? structuredClone(template.leaseTemplateImportReview) : undefined,
      listingSeedKey: undefined,
    };
    if (!(await persistTemplates([...templates, duplicate]))) {
      showToast("Could not duplicate lease.");
      return;
    }
    onUpdated();
    showToast("Lease duplicated.");
  };

  // Makes one lease the default of a stay: the lease carries `defaultFor` (explicit, so routing follows it);
  // a stay nobody set keeps routing exactly as before.
  const setStayDefault = async (templateId: string, stay: LeaseStay) => {
    if (!(await persistTemplates(withLeaseDefaultForStay(templates, templateId, stay)))) {
      showToast("Could not set default.");
      return;
    }
    showToast(`Default for ${stay === "long_term" ? "long term" : "short term"} set.`);
    onUpdated();
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
    const notOffered = template.offered === false;
    const stay = leaseTemplateStay(template);
    // The stay's explicit default; with none set, the property's older single default lease still stars.
    const explicitDefault = explicitDefaultLeaseForStay(templates, stay);
    const isDefault =
      !notOffered &&
      (explicitDefault
        ? explicitDefault.id === template.id
        : Boolean(
            formSetup.loaded &&
              formSetup.leasingPipeline.defaultLeaseTemplateId &&
              formSetup.leasingPipeline.defaultLeaseTemplateId === template.id,
          ));
    const rowLabel = template.label?.trim() || "Lease";
    // One derivation with the Edit lease popup's "Type of lease": the stay types this lease is mapped to.
    const mappedTypeLabel =
      (template.applicationLeaseTerms ?? []).length > 0
        ? stayTypeLabelForLeaseKindDisplay(template.applicationLeaseTerms ?? [], offeredStayTypeTerms(syncedSub), typeLabel)
        : typeLabel;
    const openPreview = () => setPreviewTemplateId(template.id);

    const rowMenu = (
      <RowActionsMenu
        label={rowLabel}
        items={[
          { id: "preview", label: "Preview", onSelect: openPreview },
          { id: "edit", label: "Edit lease", onSelect: () => openEdit(template.id) },
          {
            id: "open-in-new-tab",
            label: "Open in new tab",
            onSelect: () => openPropertyFormTemplateInNewTab("lease", template.id),
          },
          !isDefault && !notOffered
            ? {
                id: "set-default",
                label: `Set as default for ${stay === "long_term" ? "long term" : "short term"}`,
                onSelect: () => void setStayDefault(template.id, stay),
              }
            : null,
          { id: "duplicate", label: "Duplicate", onSelect: () => void duplicateTemplate(template) },
          { id: "promo-codes", label: "Promo codes", onSelect: () => setPromoOpen(true) },
          {
            id: "delete",
            label: "Delete",
            danger: true,
            onSelect: () => {
              void confirm({ title: "Delete lease", description: `Delete ${rowLabel}?`, confirmLabel: "Delete lease" }).then(
                (ok) => {
                  if (ok) handleDelete(template.id);
                },
              );
            },
          },
        ]}
      />
    );

    return (
      <PortalPropertyRecordRow
        key={template.id}
        title={rowLabel}
        leading={<PortalRowIconTile icon={FileText} />}
        leadingShape="square"
        facts={
          <>
            {mappedTypeLabel ? (
              <PortalRowFact icon={FileText} srLabel="Lease type">
                {mappedTypeLabel}
              </PortalRowFact>
            ) : null}
            {notOffered ? (
              <PortalRowFact icon={AlertTriangle} srLabel="Not offered">
                Not offered
              </PortalRowFact>
            ) : null}
            {isDefault ? (
              <PortalRowFact icon={Star} srLabel="Default">
                Default
              </PortalRowFact>
            ) : null}
            {template.leaseTemplateDocName ? (
              <PortalRowFact icon={FileUp} srLabel="Source">
                From {template.leaseTemplateDocName}
              </PortalRowFact>
            ) : null}
          </>
        }
        checked={embedInModal ? selectedIds.has(template.id) : undefined}
        onSelectedChange={embedInModal ? () => toggleSelected(template.id) : undefined}
        selectLabel={rowLabel}
        onOpen={openPreview}
        actions={rowMenu}
        dataAttr={`property-lease-row-${template.id}`}
      />
    );
  };

  const seedTypeLabel = (seedKey: PropertyLeaseListingSeedKey | undefined): string | null => {
    if (seedKey === "primary") return "Long-term";
    if (seedKey === "short-term") return "Short-term";
    if (seedKey === "airbnb") return "Airbnb";
    return null;
  };

  // The round + is a menu: the blank "Add lease" first, then each PropLane default the property lacks.
  const addMenu = {
    entries: leasingPlusMenuEntries("Add lease", missingDefaults),
    onSelect: (entry: LeasingPlusMenuEntry) => {
      if (entry.kind === "blank") openAdd();
      else addSeedTemplate(entry.key as PropertyLeaseListingSeedKey);
    },
  };

  const catalogBody = (
    <>
      <>
        {visibleTemplates.map((template) => renderLeaseTemplateRow(template, seedTypeLabel(template.listingSeedKey)))}
      </>
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
        bulk={bulkPropertyIds.length > 0}
        initialStay={formMode === "add" ? addStay : undefined}
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
        onSave={async (nextTemplates, extra) => {
          if (
            !(await persistTemplates(
              nextTemplates,
              extra?.allowedLeaseTerms ? { allowedLeaseTerms: extra.allowedLeaseTerms } : undefined,
              extra?.applications,
              extra?.touchedLeaseOptions,
            ))
          ) {
            showToast("Could not save lease.");
            return false;
          }
          showToast("Lease saved.");
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
        onClose={() => setQuestionsEditorTemplate(null)}
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
      stayTabs={{
        items: tabItems,
        activeId: activeTab,
        onChange: (id) => setTab(id as PropertyStay),
        ariaLabel: "Leases",
      }}
      search={
        activeStay
          ? {
              value: leaseSearch,
              onChange: setLeaseSearch,
              placeholder: "Search leases",
              dataAttr: "property-lease-search",
            }
          : undefined
      }
      filter={activeStay ? formFilterSheet : null}
      onAdd={openAdd}
      addMenu={addMenu}
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
  ) : (
    // Embedded in a pop-up (Settings › Leases › Form): no tabs, no search, no filter — but the blue +
    // in the header is the one create action, so the pane keeps a band that carries just it.
    <PropertyFormAutomationCommandBar
      pane="form"
      onPaneChange={() => {}}
      panes={[{ id: "form", label: "Form" }]}
      onAdd={openAdd}
      addMenu={addMenu}
      addLabel="Add lease"
      addDataAttr="property-lease-add"
    />
  );

  const soloTemplateId = readSoloPropertyFormTemplateId(searchParams, "lease");
  const soloTemplate = soloTemplateId ? templates.find((t) => t.id === soloTemplateId) ?? null : null;
  if (!embedInModal && soloTemplate) {
    return (
      <PropertyLeaseTemplateInlinePreview
        template={soloTemplate}
        sub={syncedSub}
        propertyHint={propertyHint}
        solo
      />
    );
  }

  const previewTemplate = previewTemplateId ? templates.find((t) => t.id === previewTemplateId) ?? null : null;

  return (
    <>
      {commandBar}
      {embedInModal || pane === "form" ? (
          <PortalRecordListSurface
            className="mt-0 pb-0 max-lg:pb-0"
            onBulkClear={embedInModal ? clearSelection : undefined}
            bulkCount={embedInModal ? selectedIds.size : 0}
            bulkActions={
              embedInModal && selectedTemplateId ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_BULK_BAR_BTN}
                  data-attr="property-lease-bulk-edit"
                  onClick={() => openEdit(selectedTemplateId)}
                >
                  Edit lease
                </Button>
              ) : null
            }
          >
          {catalogBody}
        </PortalRecordListSurface>
      ) : null}

      <PropertyFormTemplatePreviewModal
        open={Boolean(previewTemplate)}
        title={previewTemplate?.label?.trim() || "Lease preview"}
        onClose={() => setPreviewTemplateId(null)}
        dataAttr="property-lease-template-preview-modal"
      >
        {previewTemplate ? (
          <PropertyLeaseTemplateInlinePreview
            template={previewTemplate}
            sub={syncedSub}
            propertyHint={propertyHint}
            solo
          />
        ) : null}
      </PropertyFormTemplatePreviewModal>

      {formModals}

      <FormPromoCodesDialog
        open={promoOpen}
        onClose={() => setPromoOpen(false)}
        kind="lease"
        propertyId={settingsPropertyId ?? propertyId ?? null}
        propertyLabel={settingsPropertyLabel ?? propertyLabel}
      />
    </>
  );
}
