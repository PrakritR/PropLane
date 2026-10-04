"use client";

/**
 * Settings -> Forms (decision D1): the workspace Forms library, on the house list surface copied from
 * Properties. Header card with Applications | Leases tabs, search and the one round +; flat rows
 * (tile · name · place line · glyph facts · ⋯). The + and Edit open the existing editors in
 * workspace scope, so a form is defined once; the ⋯ also picks which properties use it. Move-in
 * forms are their own page and are not here.
 *
 * Storage and rules: `leasing-forms-library.ts` (the library is the same template records a property
 * carries; a property's own list stays the one thing every consumer reads).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { CalendarClock, ClipboardList, FileText, ListChecks, Sparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  EMPTY_LEASING_FORMS_LIBRARY,
  duplicateLibraryForm,
  filterLibraryForms,
  libraryFormFacts,
  libraryFormUseCount,
  libraryFromEditedSubmission,
  librarySubmissionShell,
  removeLibraryForm,
  stripServerOwnedFromLibrary,
  upsertLibraryForm,
  propertyFormPicks,
  type LeasingFormKind,
  type LeasingFormsLibrary,
} from "@/lib/leasing-forms-library";
import {
  fetchLeasingFormsLibrary,
  listLibraryProperties,
  pushLibraryFormToProperties,
  putLeasingFormsLibrary,
  savePropertyPicks,
  type LibraryProperty,
} from "@/lib/leasing-forms-library.client";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";

export const LEASING_FORMS_TAB_PARAM = "forms";
const TABS: readonly { id: LeasingFormKind; param: "applications" | "leases"; label: string; noun: string }[] = [
  { id: "application", param: "applications", label: "Applications", noun: "application" },
  { id: "lease", param: "leases", label: "Leases", noun: "lease" },
];

type AnyForm = PropertyApplicationTemplate | PropertyLeaseTemplate;

export function leasingFormsTabFromParam(raw: string | null | undefined): LeasingFormKind {
  return raw === "leases" ? "lease" : "application";
}

/** The glyph facts on a row: where it started, how long it is, and (applications) when it comes against the tour. */
export function leasingFormRowFacts(kind: LeasingFormKind, form: AnyForm, propertyCount: number) {
  const facts = libraryFormFacts(kind, form, propertyCount);
  const glyphs: PortalEntryRowFact[] = [{ icon: Sparkles, label: facts.startSource, srLabel: "Started from" }];
  if (kind === "application") {
    glyphs.push({ icon: ListChecks, label: `${facts.questionCount} questions`, srLabel: "Questions" });
    if (facts.tourOrder) glyphs.push({ icon: CalendarClock, label: facts.tourOrder, srLabel: "Tour order" });
  }
  const place = `${facts.leaseTypes.join(", ")} · ${propertyCount === 1 ? "1 property" : `${propertyCount} properties`}`;
  return { glyphs, place };
}

export function LeasingFormsPanel() {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const demo = isDemoModeActive();
  const { userId } = useManagerUserId();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const kind = leasingFormsTabFromParam(searchParams?.get(LEASING_FORMS_TAB_PARAM));

  const [library, setLibrary] = useState<LeasingFormsLibrary>(EMPTY_LEASING_FORMS_LIBRARY);
  const [loading, setLoading] = useState(!demo);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: LeasingFormKind; mode: "add" | "edit"; id: string | null } | null>(null);
  const [pickerFormId, setPickerFormId] = useState<string | null>(null);
  const [propertiesTick, setPropertiesTick] = useState(0);

  const load = useCallback(async () => {
    if (demo) return;
    setLoading(true);
    setLoadError(false);
    try {
      setLibrary(await fetchLeasingFormsLibrary());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [demo]);
  useEffect(() => {
    void load();
  }, [load]);

  // The properties and their own lists: counts and the picker read them from the local store.
  const properties = useMemo<LibraryProperty[]>(
    () => listLibraryProperties(userId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, propertiesTick, library],
  );

  const saveLibrary = useCallback(
    async (next: LeasingFormsLibrary): Promise<boolean> => {
      const cleaned = stripServerOwnedFromLibrary(next);
      if (demo) {
        setLibrary(cleaned);
        return true;
      }
      try {
        setLibrary(await putLeasingFormsLibrary(cleaned));
        return true;
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not save forms.");
        return false;
      }
    },
    [demo, showToast],
  );

  /** After a form changed, bring every property that uses it up to date. */
  const pushToProperties = useCallback(
    async (formKind: LeasingFormKind, form: AnyForm) => {
      if (demo || !userId) return;
      const result = await pushLibraryFormToProperties({
        userId,
        kind: formKind,
        form,
        propertyIds: properties.map((property) => property.id),
      });
      if (result.failed > 0) showToast("Some properties could not be updated. Open them and try again.");
      else if (result.updated > 0) showToast(result.updated === 1 ? "Updated on 1 property." : `Updated on ${result.updated} properties.`);
      setPropertiesTick((n) => n + 1);
    },
    [demo, properties, showToast, userId],
  );

  const tab = TABS.find((entry) => entry.id === kind)!;
  const forms: AnyForm[] = kind === "application" ? library.applications : library.leases;
  const visible = useMemo(() => filterLibraryForms(kind, forms, query), [kind, forms, query]);
  const useCount = (form: AnyForm) => libraryFormUseCount(form.id, kind, properties.map((property) => property.sub));

  const destinations = TABS.map((entry) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set(LEASING_FORMS_TAB_PARAM, entry.param);
    return {
      id: entry.id,
      label: entry.label,
      count: (entry.id === "application" ? library.applications : library.leases).length,
      href: `${pathname}?${params.toString()}`,
      dataAttr: `leasing-forms-tab-${entry.param}`,
    };
  });

  const editingForm = editor && editor.id ? forms.find((form) => form.id === editor.id) ?? null : null;
  const shell = useMemo(() => librarySubmissionShell(createDefaultListingSubmission(), library), [library]);

  const closeEditor = () => setEditor(null);

  const removeForm = async (form: AnyForm) => {
    if (!(await confirm({ description: `Delete ${form.label}? Properties keep the copy they already use.` }))) return;
    if (await saveLibrary(removeLibraryForm(library, kind, form.id))) {
      setSelectedId(null);
      showToast(`${tab.label.slice(0, -1)} deleted.`);
    }
  };

  const duplicateForm = async (form: AnyForm) => {
    const copy = duplicateLibraryForm(kind, form);
    if (await saveLibrary(upsertLibraryForm(library, kind, copy))) showToast(`${tab.label.slice(0, -1)} duplicated.`);
  };

  const selectedForm = selectedId ? forms.find((form) => form.id === selectedId) : undefined;
  const menu = (form: AnyForm) => (
    <PortalSectionActionRow variant="header">
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="leasing-form-edit" onClick={() => setEditor({ kind, mode: "edit", id: form.id })}>
        Edit
      </Button>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="leasing-form-properties" onClick={() => setPickerFormId(form.id)}>
        Properties
      </Button>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="leasing-form-duplicate" onClick={() => void duplicateForm(form)}>
        Duplicate
      </Button>
      <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} data-attr="leasing-form-delete" onClick={() => void removeForm(form)}>
        Delete
      </Button>
    </PortalSectionActionRow>
  );

  const emptyCard =
    forms.length === 0
      ? { title: `No ${tab.noun} forms yet`, actions: [{ label: `Add ${tab.noun}`, onClick: () => setEditor({ kind, mode: "add", id: null }), dataAttr: "leasing-forms-empty-add" }] }
      : {
          title: portalEmptyNoMatchTitle(`${tab.noun} forms`, query),
          tone: "muted" as const,
          clear: { label: "Clear search", onClick: () => setQuery(""), dataAttr: "leasing-forms-empty-clear" },
        };

  const tile: { kind: "glyph"; icon: LucideIcon } = { kind: "glyph", icon: kind === "application" ? ClipboardList : FileText };

  return (
    <div className="min-w-0 space-y-3" data-attr="leasing-forms-panel">
      <PortalListControlStack
        variant="command"
        stickyDestinations
        destinationAriaLabel="Forms"
        activeDestinationId={kind}
        destinations={destinations}
        search={{ value: query, onChange: setQuery, placeholder: `Search ${tab.label.toLowerCase()}`, dataAttr: "leasing-forms-search" }}
        primary={
          <PortalPrimaryIconAction
            label={portalListAddPrimaryLabel(tab.noun)}
            data-attr="leasing-forms-add"
            onClick={() => setEditor({ kind, mode: "add", id: null })}
          />
        }
      />
      <PortalRecordListSurface
        isEmpty={visible.length === 0}
        loading={loading}
        loadError={loadError ? "Couldn't load forms" : undefined}
        onRetry={() => void load()}
        emptyCard={emptyCard}
        onBulkClear={() => setSelectedId(null)}
        bulkCount={selectedForm ? 1 : 0}
        bulkActions={selectedForm ? menu(selectedForm) : undefined}
        dataAttr="leasing-forms-list"
      >
        {visible.map((form) => {
          const row = leasingFormRowFacts(kind, form, useCount(form));
          return (
            <PortalEntryRow
              key={form.id}
              tile={tile}
              title={form.label}
              place={row.place}
              facts={row.glyphs}
              checked={selectedId === form.id}
              onSelectedChange={(checked) => setSelectedId(checked ? form.id : null)}
              onOpen={() => setEditor({ kind, mode: "edit", id: form.id })}
              omitActionView
              selectLabel={form.label}
              dataAttr="leasing-form-row"
            />
          );
        })}
      </PortalRecordListSurface>

      {editor?.kind === "application" ? (
        <ManagerApplicationQuestionsEditorModal
          open
          title={editor.mode === "add" ? "Add application" : "Edit application"}
          sub={shell}
          managerUserId={userId ?? ""}
          initialVariant={(editingForm as PropertyApplicationTemplate | null)?.formVariant ?? "standard"}
          lockVariant={Boolean(editingForm)}
          templateEditorMode={editor.mode}
          applicationTemplate={(editingForm as PropertyApplicationTemplate | null) ?? null}
          templates={library.applications}
          signingOrder="application_then_lease"
          canDelete={editor.mode === "edit"}
          onDelete={editingForm ? () => void removeForm(editingForm).then(closeEditor) : undefined}
          onPersistSubmission={async (merged, opts) => {
            const edited = libraryFromEditedSubmission(merged);
            // Only applications change here; the leases come from the library, never from the editor's seeds.
            const next = { applications: edited.applications, leases: library.leases };
            if (!(await saveLibrary(next))) return false;
            showToast(opts.message);
            const saved = editor.id ? next.applications.find((form) => form.id === editor.id) : undefined;
            if (saved) void pushToProperties("application", saved);
            return true;
          }}
          onClose={closeEditor}
          onSaved={() => undefined}
          showToast={showToast}
        />
      ) : null}

      {editor?.kind === "lease" ? (
        <PropertyLeaseFormModal
          open
          mode={editor.mode}
          sub={shell}
          template={(editingForm as PropertyLeaseTemplate | null) ?? null}
          templates={library.leases}
          demoMode={demo}
          canDelete={editor.mode === "edit"}
          onDelete={editingForm ? () => void removeForm(editingForm).then(closeEditor) : undefined}
          onClose={closeEditor}
          onSave={async (nextLeases, extra) => {
            const next = { applications: extra?.applications ?? library.applications, leases: nextLeases };
            if (!(await saveLibrary(next))) return false;
            showToast("Lease saved.");
            const saved = editor.id ? next.leases.find((form) => form.id === editor.id) : undefined;
            if (saved) void pushToProperties("lease", saved);
            return true;
          }}
          showToast={showToast}
        />
      ) : null}

      {pickerFormId ? (
        <PropertiesPicker
          form={forms.find((form) => form.id === pickerFormId) ?? null}
          kind={kind}
          properties={properties}
          onClose={() => setPickerFormId(null)}
          onSave={async (formId, propertyIds) => {
            if (demo || !userId) return;
            let added = 0;
            let removed = 0;
            let draftOnly = 0;
            let failed = 0;
            for (const property of properties) {
              const current = propertyFormPicks(property.sub, kind);
              const wants = propertyIds.has(property.id);
              if (current.has(formId) === wants) continue;
              const picks = new Set(current);
              if (wants) picks.add(formId);
              else picks.delete(formId);
              const result = await savePropertyPicks({ userId, propertyId: property.id, kind, pickedIds: picks, library });
              added += result.added;
              removed += result.removed;
              draftOnly += result.draftOnly;
              failed += result.failed;
            }
            setPropertiesTick((n) => n + 1);
            if (failed > 0) showToast("Some properties could not be updated. Try again.");
            else if (draftOnly > 0) showToast("Saved. Some applications are drafts until their questions can be published.");
            else if (added + removed > 0) showToast("Properties updated.");
          }}
        />
      ) : null}
    </div>
  );
}

function PropertiesPicker({
  form,
  kind,
  properties,
  onClose,
  onSave,
}: {
  form: AnyForm | null;
  kind: LeasingFormKind;
  properties: LibraryProperty[];
  onClose: () => void;
  onSave: (formId: string, propertyIds: Set<string>) => Promise<void>;
}) {
  const initial = useMemo(
    () => (form ? properties.filter((property) => propertyFormPicks(property.sub, kind).has(form.id)).map((property) => property.id) : []),
    [form, kind, properties],
  );
  const [selected, setSelected] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);
  if (!form) return null;
  return (
    <Modal
      open
      title={form.label}
      onClose={onClose}
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} data-attr="leasing-form-properties-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            data-attr="leasing-form-properties-save"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(form.id, new Set(selected));
              setSaving(false);
              onClose();
            }}
          >
            Save
          </Button>
        </ModalFooter>
      }
    >
      <CheckboxMultiSelect
        label="Properties"
        options={properties.map((property) => ({ value: property.id, label: property.label }))}
        selected={selected}
        onChange={setSelected}
        emptyMenuText="No properties yet"
        emptyLabel="No properties"
        dataAttr="leasing-form-properties-select"
      />
    </Modal>
  );
}
