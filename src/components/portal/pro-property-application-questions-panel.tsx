"use client";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { CalendarDays, ClipboardList, CreditCard, FileUp, Moon, Star } from "lucide-react";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PropertyApplicationTemplateInlinePreview } from "@/components/portal/property-application-template-inline-preview";
import { PropertyFormTemplatePreviewModal } from "@/components/portal/property-form-template-preview-modal";
import { openPropertyFormTemplateInNewTab } from "@/components/portal/property-form-template-open-tab";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { usePropertyFormSetupSettings } from "@/lib/property-form-setup-settings.client";
import { STAY_LABEL, listingOfferedStays, type StaySectionKey } from "@/lib/listing-stays";
import {
  stayCounts,
  stayLabel,
  stayTabsFor,
  type PropertyStay,
} from "@/lib/property-stay-tabs";
import { applicationFeeFactForTerms } from "@/lib/form-resolved-fee";
import { applicationIdForStayTerm, offeredStayTypeTerms } from "@/lib/property-form-stay-type-routing";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { PropertyFormAutomationCommandBar } from "@/components/portal/property-form-automation-chrome";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { usePublishModalBulkActions } from "@/hooks/use-publish-modal-bulk-actions";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applicationConfigFieldsFromSubmission,
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import {
  applicationAppliesTo,
  applicationCoversStay,
  applicationFormVariantForTemplate,
  effectiveDefaultApplicationForStay,
  groupApplicationTemplatesByStay,
  isApplicationTemplateOffered,
  readPropertyApplicationTemplates,
  withApplicationAppliesTo,
  withApplicationDefaultForStay,
  withoutShortTermCosignerLinks,
  removePropertyApplicationTemplate,
  withPropertyApplicationTemplatesExplicit,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  availableApplicationTemplateSeeds,
  submissionAfterRemovingApplicationTemplate,
  syncPropertyApplicationTemplatesFromListing,
} from "@/lib/property-application-template-sync";
import { LeasingQuickAddRow } from "@/components/portal/leasing-quick-add-row";
import { FormPromoCodesDialog } from "@/components/portal/form-promo-codes";
import { missingApplicationDefaults, submissionWithApplicationDefault } from "@/lib/leasing-quick-add";
import { normalizePropertyApplicationTemplateLabel } from "@/lib/property-application-template-sync";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import { useConfirm } from "@/components/providers/app-ui-provider";

/**
 * "Ida Cares Homes_Intake Form.pdf" -> "Intake Form": a manager's uploaded
 * PDF becomes a NAMED form (captain override — never a Lease/Application
 * nav rename), and most exported application/lease PDFs are named
 * "<workspace or property>_<form name>.pdf". Take the text after the last
 * "_" or "-" when present (dropping the extension) as a reasonable default
 * name; the manager can still rename it like any other form. No separator
 * falls back to the whole filename.
 */
export function deriveFormNameFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.pdf$/i, "").trim();
  const lastSeparator = Math.max(withoutExt.lastIndexOf("_"), withoutExt.lastIndexOf("-"));
  const candidate = lastSeparator >= 0 ? withoutExt.slice(lastSeparator + 1).trim() : withoutExt;
  return candidate || "Uploaded form";
}

/** A section header: a small glyph, the label and a rule line (same look as the listing step's StayHeader). */
function StayHeader({ section }: { section: StaySectionKey }) {
  return (
    <div className="mb-2.5 mt-1 flex items-center gap-2 text-[13px] font-bold text-foreground/80" data-attr={`property-application-stay-header-${section}`}>
      {section === "long_term" ? <CalendarDays className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
      {section === "short_term" ? <Moon className="h-4 w-4 shrink-0 text-muted" aria-hidden /> : null}
      <span>{STAY_LABEL[section]}</span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

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
 *
 * The Applications-section Edit modal publishes selection actions through
 * `onBulkActionsChange`. The property Application tab never shows "Edit
 * application" — it matches the lease tab (checkbox rows, presets, ADD).
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
  onBulkActionsChange,
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
  /**
   * Applications-section Edit modal only — renders "Edit application" in the
   * parent dialog footer instead of a fixed bulk bar behind the overlay.
   */
  onBulkActionsChange?: (actions: ReactNode | null) => void;
}) {
  const confirm = useConfirm();
  const [pane, setPane] = useState<"form" | "automation">("form");
  const [formKindFilter, setFormKindFilter] = useState("");
  const [applicationSearch, setApplicationSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("edit");
  const [editingTemplate, setEditingTemplate] = useState<PropertyApplicationTemplate | null>(null);
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const syncedSub = useMemo(() => syncPropertyApplicationTemplatesFromListing(sub), [sub]);
  const templates = useMemo(() => readPropertyApplicationTemplates(syncedSub), [syncedSub]);
  const leases = useMemo(() => readPropertyLeaseTemplates(syncedSub), [syncedSub]);
  const embedInModal = Boolean(onBulkActionsChange);
  // Long term · Short term. A stay the property does not allow loses its tab unless it still holds an application
  // the manager owns (never hide data); an untouched PropLane default the sync switched off for a stay the
  // property does not offer (`stayHidden`) does not count. An application for both stays counts in, and is
  // listed under, each tab. The stay's default is a row inside its list (a Default fact + "Set as default").
  const [tab, setTab] = useState<PropertyStay>("long_term");
  const counted = useMemo(() => templates.filter((row) => !row.stayHidden), [templates]);
  const tabItems = useMemo(
    () => {
      const counts = stayCounts(counted, (row) => applicationAppliesTo(row, leases));
      // An application for both stays is listed in the allowed stay's tab already, so only one that is for a
      // disallowed stay ALONE keeps that stay's tab alive (never hide data, never show an empty stay).
      const onlyHere = (stay: PropertyStay) => counted.filter((row) => applicationAppliesTo(row, leases) === stay).length;
      const held = { long_term: onlyHere("long_term"), short_term: onlyHere("short_term") };
      return stayTabsFor(syncedSub, held).map((stay) => ({
        id: stay,
        label: stayLabel(stay),
        count: counts[stay],
        dataAttr: `property-application-tab-${stay}`,
      }));
    },
    [counted, leases, syncedSub],
  );
  const activeTab: PropertyStay = tabItems.some((item) => item.id === tab) ? tab : tabItems[0]!.id;
  const activeStay: PropertyStay = activeTab;
  const [addStay, setAddStay] = useState<PropertyStay | undefined>(undefined);
  const tabAddStay: PropertyStay | undefined = embedInModal ? undefined : activeStay;
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(templates.length);

  const bulkPropertyIds = propertyIds?.filter((id) => id.trim()) ?? [];
  const applicationPreviewPropertyId = useMemo(
    () =>
      resolveApplicationPreviewPropertyId({
        listingId,
        saveTarget,
        managerUserId,
        bulkPropertyIds,
      }),
    [listingId, saveTarget, managerUserId, bulkPropertyIds],
  );
  // `settingsPropertyLabel` no longer resolves a local automation sheet (C228)
  // — kept as a prop so callers need no change, just unused here.
  void settingsPropertyLabel;

  // P001/P003/P011: the account application fee, this property's pipeline
  // order/default template, read once per property so every row can show its
  // real Default / fee / signs-first facts and the Setup step (inside the
  // editor modal) can edit the same values.
  const rowFactPropertyId = settingsPropertyId ?? (bulkPropertyIds.length === 0 ? saveTarget?.saveId ?? null : null);
  const formSetup = usePropertyFormSetupSettings(rowFactPropertyId);

  // The stay types each application serves (the same routing the form editor's fee card uses), so a row's
  // fee is the number the listing shows for that lease type.
  const applicationTermsFor = useCallback(
    (templateId: string): string[] => {
      const offered = offeredStayTypeTerms(syncedSub);
      const leases = readPropertyLeaseTemplates(syncedSub);
      const catalog = { applications: templates, leases };
      const routed = offered.filter(
        (term) => applicationIdForStayTerm(catalog, "application_then_lease", leases, term) === templateId,
      );
      return routed.length ? routed : offered;
    },
    [syncedSub, templates],
  );

  const persistSubmission = useCallback(
    async (merged: ManagerListingSubmissionV1, opts: { message: string }) => {
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
          if (await persistManagerListingSubmissionOnServer(hit.saveTarget, managerUserId, next)) saved += 1;
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
      if (!(await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, merged))) {
        showToast("Could not save application settings.");
        return false;
      }
      showToast(opts.message);
      return true;
    },
    [bulkPropertyIds, managerUserId, saveTarget, showToast],
  );

  const persistRemoval = async (nextTemplates: PropertyApplicationTemplate[]) => {
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
        const persisted = await persistManagerListingSubmissionOnServer(
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
    return persistManagerListingSubmissionOnServer(
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
  /**
   * Quick add adds to the tab you are on: only the defaults the open stay's tab would then list are offered,
   * derived from the seed by the same rule the created application is read back with (`applicationAppliesTo`),
   * so a co-signer form never shows under Short term and a short-term form never under Long term.
   */
  const quickAddEntries = useMemo(
    () => missingApplicationDefaults(sub, embedInModal ? undefined : activeStay),
    [activeStay, embedInModal, sub],
  );

  const addSeedTemplate = useCallback(
    async (seedKey: string) => {
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
          const base = hit.sub.propertyApplicationTemplatesExplicit
            ? hit.sub
            : syncPropertyApplicationTemplatesFromListing(hit.sub);
          const next = submissionWithApplicationDefault(base, seedKey as never);
          if (next === base) {
            skipped += 1;
            continue;
          }
          if (await persistManagerListingSubmissionOnServer(hit.saveTarget, managerUserId, next)) saved += 1;
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

      if (!saveTarget) {
        showToast("Could not add application.");
        return;
      }
      const base = sub.propertyApplicationTemplatesExplicit ? sub : syncedSub;
      const next = submissionWithApplicationDefault(base, seedKey as never);
      if (next === base) {
        showToast("That application is already on this property.");
        return;
      }
      const label = availableSeeds.find((s) => s.seedKey === seedKey)?.label ?? "Application";
      if (!(await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, next))) {
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
    setAddStay(tabAddStay);
    setEditorOpen(true);
  }, [tabAddStay]);

  const openEditApplication = useCallback(async (template: PropertyApplicationTemplate) => {
    // Older properties render their default forms from listing terms before the
    // generated templates have been stored. The PDF import route reads the
    // owned property row, so save the displayed template before opening it.
    if (bulkPropertyIds.length === 0 && !readPropertyApplicationTemplates(sub).some((stored) => stored.id === template.id)) {
      const saved = await persistSubmission(syncedSub, { message: "Application ready to edit." });
      if (!saved) return;
      onUpdated();
    }
    setEditorMode("edit");
    setEditingTemplate(template);
    setEditorOpen(true);
  }, [bulkPropertyIds.length, onUpdated, persistSubmission, sub, syncedSub]);

  useEffect(() => {
    onRegisterAddApplication?.(openAdd);
    return () => onRegisterAddApplication?.(null);
  }, [onRegisterAddApplication, openAdd]);

  const visibleTemplates = useMemo(() => {
    const q = applicationSearch.trim().toLowerCase();
    let rows = templates.filter((template) => !template.stayHidden);
    if (formKindFilter) {
      rows = rows.filter((template) => applicationFormVariantForTemplate(template) === formKindFilter);
    }
    if (!q) return rows;
    return rows.filter((template) => {
      const label = normalizePropertyApplicationTemplateLabel(template.label);
      return label.toLowerCase().includes(q);
    });
  }, [applicationSearch, formKindFilter, templates]);

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
        data-attr="property-application-bulk-edit"
        onClick={() => {
          const template = templates.find((row) => row.id === templateId);
          if (template) openEditApplication(template);
        }}
      >
        Edit application
      </Button>
    );
  }, [openEditApplication, selectedTemplateId, templates]);

  usePublishModalBulkActions(
    onBulkActionsChange,
    selectedTemplateId ?? "",
    modalBulkActions,
  );

  const handleDeleteTemplate = async (templateId: string) => {
    const next = removePropertyApplicationTemplate(templates, templateId);
    const persisted = await persistRemoval(next);
    if (!persisted) {
      showToast("Could not delete application.");
      return;
    }
    setEditorOpen(false);
    setEditingTemplate(null);
    onUpdated();
    showToast("Application deleted.");
  };

  const duplicateTemplate = async (template: PropertyApplicationTemplate) => {
    const created = createPropertyApplicationTemplate({
      kind: template.kind,
      label: `${template.label} copy`,
      applicationLeaseTerms: template.applicationLeaseTerms,
      formVariant: template.formVariant,
    });
    const duplicate: PropertyApplicationTemplate = {
      ...template,
      ...created,
      listingSeedKey: undefined,
      // A copy never takes the original's place as a stay's default.
      defaultFor: undefined,
      draftQuestionConfig: template.draftQuestionConfig ? structuredClone(template.draftQuestionConfig) : undefined,
      publishedQuestionConfig: template.publishedQuestionConfig ? structuredClone(template.publishedQuestionConfig) : undefined,
      publishedQuestionConfigVersions: template.publishedQuestionConfigVersions
        ? structuredClone(template.publishedQuestionConfigVersions)
        : undefined,
    };
    const next = [...templates, duplicate];
    if (!(await persistSubmission(withPropertyApplicationTemplatesExplicit(syncedSub, next), { message: "Application duplicated." }))) {
      showToast("Could not duplicate application.");
      return;
    }
    onUpdated();
  };

  const applicationGroups = useMemo(
    () => groupApplicationTemplatesByStay(templates, leases, visibleTemplates),
    [leases, templates, visibleTemplates],
  );

  const commitTemplates = async (next: PropertyApplicationTemplate[], message: string) => {
    // Co-signer is long term only: a short-term application never keeps a co-signer link.
    const written = withoutShortTermCosignerLinks(next, leases);
    if (!(await persistSubmission(withPropertyApplicationTemplatesExplicit(syncedSub, written), { message }))) return;
    onUpdated();
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingTemplate(null);
    clearSelection();
  };

  const editorTitle = editorMode === "add" ? "Add application" : "Edit application";

  if (!managerUserId || (!saveTarget && bulkPropertyIds.length === 0)) return null;

  const formFilterSheet = !embedInModal ? (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([formKindFilter])}
      compactPanel
      commandStripTrigger
      dropdownAlign="start"
      filterFieldCount={1}
      mobileFlushBody
      onReset={() => setFormKindFilter("")}
      dataAttr="property-application-filter-sheet-open"
    >
      <PortalFormSingleSelect
        label="Form"
        value={formKindFilter}
        onChange={setFormKindFilter}
        options={[
          { value: "", label: "All forms" },
          { value: "standard", label: "Long-term" },
          { value: "short_term", label: "Short-term" },
          { value: "cosigner", label: "Co-signer" },
        ]}
        placeholder="All forms"
        dataAttr="property-application-filter-kind"
      />
    </PortalFilterSortSheet>
  ) : null;

  const catalogBody = (
    <>
      <>
        {(embedInModal ? applicationGroups : applicationGroups.filter((group) => group.id === activeStay)).map((group) => (
          <section key={group.id} className="mb-4" data-attr={`property-application-stay-section-${group.id}`} aria-label={group.label}>
            {embedInModal ? <StayHeader section={group.id} /> : null}
            {group.rows.map(({ template, appliesTo, stay, isDefault }) => {
          const isCosignerRow = applicationFormVariantForTemplate(template) === "cosigner";
          const sourceName =
            template.publishedQuestionConfig?.importProvenance?.sourceName ??
            template.draftQuestionConfig?.importProvenance?.sourceName ??
            null;
          const feeFact = applicationFeeFactForTerms(
            syncedSub,
            applicationTermsFor(template.id),
            formSetup.loaded ? formSetup.applicationSettings.applicationFeeCents : null,
          );
          const rowLabel = normalizePropertyApplicationTemplateLabel(template.label);
          const openPreview = () => setPreviewTemplateId(template.id);
          const openEditor = () => openEditApplication(template);
          const rowMenu = (
            <RowActionsMenu
              label={rowLabel}
              items={[
                { id: "preview", label: "Preview", onSelect: openPreview },
                { id: "edit", label: "Edit", onSelect: openEditor },
                {
                  id: "open-in-new-tab",
                  label: "Open in new tab",
                  onSelect: () => openPropertyFormTemplateInNewTab("application", template.id),
                },
                ...(!isCosignerRow && !isDefault
                  ? [
                      {
                        id: "set-default",
                        label: `Set as default for ${STAY_LABEL[stay].toLowerCase()}`,
                        onSelect: () =>
                          void commitTemplates(
                            withApplicationDefaultForStay(templates, template.id, stay),
                            `Default for ${STAY_LABEL[stay].toLowerCase()} set.`,
                          ),
                      },
                    ]
                  : []),
                ...(isCosignerRow
                  ? []
                  : (["long_term", "short_term", "both"] as const)
                      .filter((target) => target !== appliesTo && (target === "both" || listingOfferedStays(syncedSub)[target]))
                      .map((target) => ({
                        id: `applies-${target}`,
                        label: target === "both" ? "Applies to both" : `Applies to ${STAY_LABEL[target].toLowerCase()} residents`,
                        onSelect: () =>
                          void commitTemplates(withApplicationAppliesTo(templates, template.id, target), "Application moved."),
                      }))),
                { id: "duplicate", label: "Duplicate", onSelect: () => void duplicateTemplate(template) },
                { id: "promo-codes", label: "Promo codes", onSelect: () => setPromoOpen(true) },
                {
                  id: "delete",
                  label: "Delete",
                  danger: true,
                  onSelect: () => {
                    void confirm({ description: `Delete ${rowLabel}?` }).then((ok) => {
                      if (ok) void handleDeleteTemplate(template.id);
                    });
                  },
                },
              ]}
            />
          );
          return (
            <PortalPropertyRecordRow
              key={`${stay}:${template.id}`}
              title={rowLabel}
              leading={<PortalRowIconTile icon={ClipboardList} />}
              leadingShape="square"
              facts={
                <>
                  {isDefault ? (
                    <PortalRowFact icon={Star}>
                      Default
                    </PortalRowFact>
                  ) : null}
                  <PortalRowFact icon={CreditCard} srLabel="Application fee">
                    {feeFact}
                  </PortalRowFact>
                  {sourceName ? (
                    <PortalRowFact icon={FileUp} srLabel="Source">
                      From {sourceName}
                    </PortalRowFact>
                  ) : null}
                </>
              }
              checked={embedInModal ? selectedIds.has(template.id) : undefined}
              onSelectedChange={embedInModal ? () => toggleSelected(template.id) : undefined}
              selectLabel={rowLabel}
              onOpen={openPreview}
              actions={rowMenu}
              dataAttr={`property-application-row-${template.id}`}
            />
          );
        })}
          </section>
        ))}
      </>

      <LeasingQuickAddRow
        entries={quickAddEntries}
        noun="application"
        dataAttr="property-application-quick-add"
        onAdd={(key) => void addSeedTemplate(key)}
      />

    </>
  );

  const editorModals = (
    <>
      {editorOpen ? (
        <ManagerApplicationQuestionsEditorModal
          open
          title={editorTitle}
          sub={syncedSub}
          saveTarget={saveTarget ?? undefined}
          propertyIds={bulkPropertyIds.length > 0 ? bulkPropertyIds : undefined}
          managerUserId={managerUserId}
          applicationPreviewPropertyId={applicationPreviewPropertyId}
          initialVariant={editingTemplate?.formVariant ?? "standard"}
          initialAppliesTo={editorMode === "add" ? addStay : undefined}
          lockVariant={Boolean(editingTemplate)}
          templateEditorMode={editorMode}
          applicationTemplate={editingTemplate}
          templates={templates}
          signingOrder={formSetup.loaded ? formSetup.leasingPipeline.pipelineOrder : undefined}
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

  // C228: the property page no longer carries its own application automation
  // block. The gear now opens Settings -> Forms, where every application
  // form's Automation block lives (same workspace-scoped storage) alongside "Used at".
  const commandBar = !embedInModal ? (
    <PropertyFormAutomationCommandBar
      pane={pane}
      onPaneChange={setPane}
      panes={[{ id: "form", label: "Form" }]}
      stayTabs={{
        items: tabItems,
        activeId: activeTab,
        onChange: (id) => setTab(id as PropertyStay),
        ariaLabel: "Applications",
      }}
      search={{
        value: applicationSearch,
        onChange: setApplicationSearch,
        placeholder: "Search applications",
        dataAttr: "property-application-search",
      }}
      filter={formFilterSheet}
      onAdd={openAdd}
      addLabel="Add application"
      addDataAttr="property-application-command-add"
      activeFilterChips={
        formKindFilter ? (
          <PortalActiveFilterChips
            chips={[
              {
                id: "form-kind",
                label:
                  formKindFilter === "short_term"
                    ? "Short-term"
                    : formKindFilter === "cosigner"
                      ? "Co-signer"
                      : "Long-term",
                onRemove: () => setFormKindFilter(""),
              },
            ]}
          />
        ) : null
      }
    />
  ) : null;

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
                data-attr="property-application-bulk-edit"
                onClick={() => {
                  const template = templates.find((row) => row.id === selectedTemplateId);
                  if (template) openEditApplication(template);
                }}
              >
                Edit application
              </Button>
            ) : null
          }
        >
          {catalogBody}
        </PortalRecordListSurface>
      ) : null}

      <PropertyFormTemplatePreviewModal
        open={Boolean(previewTemplate)}
        title={previewTemplate?.label?.trim() || "Application preview"}
        onClose={() => setPreviewTemplateId(null)}
        dataAttr="property-application-template-preview-modal"
      >
        {previewTemplate ? (
          <PropertyApplicationTemplateInlinePreview
            template={previewTemplate}
            sub={syncedSub}
            propertyId={applicationPreviewPropertyId}
            solo
          />
        ) : null}
      </PropertyFormTemplatePreviewModal>

      {editorModals}

      <FormPromoCodesDialog
        open={promoOpen}
        onClose={() => setPromoOpen(false)}
        kind="application"
        propertyId={settingsPropertyId ?? saveTarget?.saveId ?? null}
        propertyLabel={settingsPropertyLabel}
      />
    </>
  );
}
