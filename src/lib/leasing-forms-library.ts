/**
 * The workspace Forms library (Settings -> Forms, decision D1): an application form and a lease form
 * are defined ONCE for the workspace, and each property picks which of them apply.
 *
 * Where things live (one source of truth each):
 * - The library holds the form DEFINITIONS, as the very same template records a property already
 *   carries (`PropertyApplicationTemplate`, `PropertyLeaseTemplate`), under
 *   `manager_automation_settings.row_data.leasingForms`. The editors therefore open on a library form
 *   unchanged.
 * - A property's own template lists (`propertyApplicationTemplates` / `propertyLeaseTemplates`) stay the
 *   ONLY thing every consumer reads (the public listing, the apply fee, Send application). Picking a
 *   library form for a property adds a copy to that list marked with `libraryFormId`; un-picking
 *   removes it. A property's own forms (no `libraryFormId`) are never touched.
 * - What an application's published questions look like stays server-owned: a library form is a
 *   DRAFT definition, and a pick publishes the copy through the existing owner-scoped publish route.
 *
 * Pure and isomorphic: the route and the page both use it.
 */
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { normalizeCustomApplicationFieldsForEditor } from "@/lib/manager-listing-submission";
import {
  makePropertyApplicationTemplateId,
  readPropertyApplicationTemplates,
  withPropertyApplicationTemplatesExplicit,
  draftQuestionConfigForTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";
import {
  makePropertyLeaseTemplateId,
  propertyLeaseTypeLabel,
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import { resolveListingApplicationFields } from "@/lib/rental-application/application-field-catalog";
import { APPLICATION_TOUR_ORDER_OPTIONS, normalizeApplicationTourOrder } from "@/lib/application-before-tour-policy";

export type LeasingFormKind = "application" | "lease";

export type LeasingFormsLibrary = {
  applications: PropertyApplicationTemplate[];
  leases: PropertyLeaseTemplate[];
};

export const EMPTY_LEASING_FORMS_LIBRARY: LeasingFormsLibrary = { applications: [], leases: [] };

/** Hard ceiling so one workspace row can never grow without bound. */
export const MAX_LIBRARY_FORMS_PER_KIND = 60;

export const LEASING_FORMS_ROW_DATA_KEY = "leasingForms";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Read a stored library, tolerating anything: unknown shapes become an empty library. */
export function normalizeLeasingFormsLibrary(raw: unknown): LeasingFormsLibrary {
  const row = record(raw);
  if (!row) return { applications: [], leases: [] };
  const applications = readPropertyApplicationTemplates({
    propertyApplicationTemplates: Array.isArray(row.applications) ? (row.applications as PropertyApplicationTemplate[]) : [],
  }).slice(0, MAX_LIBRARY_FORMS_PER_KIND);
  const leases = (Array.isArray(row.leases) ? readPropertyLeaseTemplates({
    propertyLeaseTemplates: row.leases as PropertyLeaseTemplate[],
    leaseConfigMode: undefined,
    leaseCustomKind: undefined,
    customLeaseTerms: undefined,
    leaseTemplateDocUrl: undefined,
    leaseTemplateDocName: undefined,
  }) : []).slice(0, MAX_LIBRARY_FORMS_PER_KIND);
  return {
    applications: dedupeById(applications),
    leases: dedupeById(leases),
  };
}

/**
 * A library form is a DRAFT definition. Publication history and the imported-source receipt are
 * server-owned (`server-owned-template-versions.ts`) and are created only per property, so a
 * library save never stores them, whatever the client sent.
 */
export function stripServerOwnedFromLibrary(library: LeasingFormsLibrary): LeasingFormsLibrary {
  return {
    applications: library.applications.map((form) => {
      const draft = form.draftQuestionConfig ?? form.publishedQuestionConfig;
      return {
        ...form,
        draftQuestionConfig: draft ? { ...draft, importProvenance: undefined } : undefined,
        publishedQuestionConfig: undefined,
        publishedQuestionConfigVersions: undefined,
      };
    }),
    leases: library.leases.map((form) => ({
      ...form,
      publishedQuestionConfig: undefined,
      publishedQuestionConfigVersions: undefined,
    })),
  };
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/** The library as a pseudo-submission, so the property editors can open on it in workspace scope. */
export function librarySubmissionShell(
  base: ManagerListingSubmissionV1,
  library: LeasingFormsLibrary,
): ManagerListingSubmissionV1 {
  return syncLegacyLeaseFieldsFromTemplates(
    withPropertyApplicationTemplatesExplicit(base, library.applications),
    library.leases,
  );
}

/** Read the library back out of what an editor handed to its persist callback. */
export function libraryFromEditedSubmission(sub: ManagerListingSubmissionV1): LeasingFormsLibrary {
  return normalizeLeasingFormsLibrary({
    applications: readPropertyApplicationTemplates(sub),
    leases: readPropertyLeaseTemplates(sub),
  });
}

/** Insert or replace one form in the library (matched by id). */
export function upsertLibraryForm(
  library: LeasingFormsLibrary,
  kind: LeasingFormKind,
  form: PropertyApplicationTemplate | PropertyLeaseTemplate,
): LeasingFormsLibrary {
  if (kind === "application") {
    const next = library.applications.some((row) => row.id === form.id)
      ? library.applications.map((row) => (row.id === form.id ? (form as PropertyApplicationTemplate) : row))
      : [...library.applications, form as PropertyApplicationTemplate];
    return { ...library, applications: next.slice(0, MAX_LIBRARY_FORMS_PER_KIND) };
  }
  const next = library.leases.some((row) => row.id === form.id)
    ? library.leases.map((row) => (row.id === form.id ? (form as PropertyLeaseTemplate) : row))
    : [...library.leases, form as PropertyLeaseTemplate];
  return { ...library, leases: next.slice(0, MAX_LIBRARY_FORMS_PER_KIND) };
}

export function removeLibraryForm(library: LeasingFormsLibrary, kind: LeasingFormKind, id: string): LeasingFormsLibrary {
  return kind === "application"
    ? { ...library, applications: library.applications.filter((row) => row.id !== id) }
    : { ...library, leases: library.leases.filter((row) => row.id !== id) };
}

/** A copy of a library form under a new id and name; it carries no publication history and no source receipt. */
export function duplicateLibraryForm(
  kind: LeasingFormKind,
  form: PropertyApplicationTemplate | PropertyLeaseTemplate,
  now = new Date().toISOString(),
): PropertyApplicationTemplate | PropertyLeaseTemplate {
  const label = `${form.label} copy`;
  if (kind === "application") {
    const source = form as PropertyApplicationTemplate;
    const draft = draftQuestionConfigForTemplate(source);
    return {
      ...source,
      id: makePropertyApplicationTemplateId(),
      label,
      listingSeedKey: undefined,
      linkedLeaseTemplateId: null,
      linkedCosignerApplicationTemplateId: null,
      draftQuestionConfig: draft ? { ...structuredClone(draft), importProvenance: undefined } : undefined,
      publishedQuestionConfig: undefined,
      publishedQuestionConfigVersions: undefined,
      createdAt: now,
      updatedAt: now,
    };
  }
  const source = form as PropertyLeaseTemplate;
  return {
    ...structuredClone(source),
    id: makePropertyLeaseTemplateId(),
    label,
    listingSeedKey: undefined,
    linkedApplicationTemplateId: null,
    linkedGuarantorLeaseTemplateId: null,
    publishedQuestionConfig: undefined,
    publishedQuestionConfigVersions: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

// --- The row facts -------------------------------------------------------------------------------

export type LibraryFormFacts = {
  /** "PropLane standard", "Uploaded PDF" ... */
  startSource: string;
  questionCount: number;
  /** Lease types the form serves ("Long-term", "Short term"); empty = every type. */
  leaseTypes: string[];
  /** Applications only: "Before the tour" / "After the tour" / "Use the workspace setting". */
  tourOrder: string | null;
  /** How many properties currently use this form. */
  propertyCount: number;
};

/** The lease type a form serves, as the manager reads it. */
function leaseTypeLabels(form: PropertyApplicationTemplate | PropertyLeaseTemplate): string[] {
  return [propertyLeaseTypeLabel(form.kind)];
}

export function applicationQuestionCount(form: PropertyApplicationTemplate): number {
  const slice = draftQuestionConfigForTemplate(form);
  if (!slice) return 0;
  return resolveListingApplicationFields(slice, normalizeCustomApplicationFieldsForEditor).length;
}

export function tourOrderLabel(order: PropertyApplicationTemplate["tourOrder"]): string {
  const value = normalizeApplicationTourOrder(order);
  return APPLICATION_TOUR_ORDER_OPTIONS.find((option) => option.value === value)?.label ?? "Use the workspace setting";
}

export function applicationStartSource(form: PropertyApplicationTemplate): string {
  const name =
    form.draftQuestionConfig?.importProvenance?.sourceName ??
    form.publishedQuestionConfig?.importProvenance?.sourceName;
  return name?.trim() ? `Uploaded ${name.trim()}` : "PropLane standard";
}

export function leaseStartSource(form: PropertyLeaseTemplate): string {
  if (form.leaseConfigMode === "custom" && form.leaseCustomKind === "document") {
    return form.leaseTemplateDocName?.trim() ? `Uploaded ${form.leaseTemplateDocName.trim()}` : "Uploaded PDF";
  }
  if (form.leaseConfigMode === "custom" && form.leaseCustomKind === "builder") return "PropLane custom builder";
  if (form.leaseConfigMode === "custom") return "PropLane custom clauses";
  return "PropLane standard";
}

export function libraryFormFacts(
  kind: LeasingFormKind,
  form: PropertyApplicationTemplate | PropertyLeaseTemplate,
  propertyCount: number,
): LibraryFormFacts {
  if (kind === "application") {
    const application = form as PropertyApplicationTemplate;
    return {
      startSource: applicationStartSource(application),
      questionCount: applicationQuestionCount(application),
      leaseTypes: leaseTypeLabels(application),
      tourOrder: tourOrderLabel(application.tourOrder),
      propertyCount,
    };
  }
  const lease = form as PropertyLeaseTemplate;
  return {
    startSource: leaseStartSource(lease),
    questionCount: 0,
    leaseTypes: leaseTypeLabels(lease),
    tourOrder: null,
    propertyCount,
  };
}

// --- Property picks ------------------------------------------------------------------------------

/** One property's view of the library, enough to count and to apply picks. */
export type PropertyFormsView = Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates" | "propertyLeaseTemplates"> &
  Partial<ManagerListingSubmissionV1>;

/** Which library forms (by library id) a property currently uses. */
export function propertyFormPicks(sub: PropertyFormsView, kind: LeasingFormKind): Set<string> {
  const rows = kind === "application"
    ? readPropertyApplicationTemplates(sub as ManagerListingSubmissionV1)
    : readPropertyLeaseTemplates(sub as ManagerListingSubmissionV1);
  return new Set(rows.map((row) => row.libraryFormId?.trim()).filter((id): id is string => Boolean(id)));
}

export function libraryFormUseCount(
  libraryId: string,
  kind: LeasingFormKind,
  properties: ReadonlyArray<PropertyFormsView>,
): number {
  return properties.filter((sub) => propertyFormPicks(sub, kind).has(libraryId)).length;
}

function copyApplicationForProperty(
  form: PropertyApplicationTemplate,
  leaseCopyIdByLibraryId: Map<string, string>,
  now: string,
): PropertyApplicationTemplate {
  const draft = draftQuestionConfigForTemplate(form);
  const linkedLease = form.linkedLeaseTemplateId ? leaseCopyIdByLibraryId.get(form.linkedLeaseTemplateId) : undefined;
  return {
    ...form,
    id: makePropertyApplicationTemplateId(),
    libraryFormId: form.id,
    listingSeedKey: undefined,
    linkedLeaseTemplateId: linkedLease ?? null,
    linkedCosignerApplicationTemplateId: null,
    // Publication and the imported-source receipt are server-owned: the copy starts as a draft.
    draftQuestionConfig: draft ? { ...structuredClone(draft), importProvenance: undefined } : undefined,
    publishedQuestionConfig: undefined,
    publishedQuestionConfigVersions: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function copyLeaseForProperty(form: PropertyLeaseTemplate, now: string): PropertyLeaseTemplate {
  return {
    ...structuredClone(form),
    id: makePropertyLeaseTemplateId(),
    libraryFormId: form.id,
    listingSeedKey: undefined,
    linkedApplicationTemplateId: null,
    linkedGuarantorLeaseTemplateId: null,
    offered: true,
    createdAt: now,
    updatedAt: now,
  };
}

export type AppliedPicks = {
  sub: ManagerListingSubmissionV1;
  /** Property copies just created that still need publishing (applications only), by property template id. */
  addedApplicationIds: string[];
  added: number;
  removed: number;
};

/**
 * Set one property's picks for one kind: library forms in `pickedIds` get a linked copy in the
 * property's own list (when it has none), linked copies of forms NOT in `pickedIds` are removed.
 * The property's own forms are never added, changed or removed.
 */
export function applyPropertyFormPicks(
  sub: ManagerListingSubmissionV1,
  kind: LeasingFormKind,
  pickedIds: ReadonlySet<string>,
  library: LeasingFormsLibrary,
  now = new Date().toISOString(),
): AppliedPicks {
  if (kind === "lease") {
    const current = readPropertyLeaseTemplates(sub);
    const have = new Set(current.map((row) => row.libraryFormId).filter((id): id is string => Boolean(id)));
    const kept = current.filter((row) => !row.libraryFormId || pickedIds.has(row.libraryFormId));
    const add = library.leases.filter((form) => pickedIds.has(form.id) && !have.has(form.id));
    const next = [...kept, ...add.map((form) => copyLeaseForProperty(form, now))];
    return {
      sub: syncLegacyLeaseFieldsFromTemplates(sub, next),
      addedApplicationIds: [],
      added: add.length,
      removed: current.length - kept.length,
    };
  }
  const current = readPropertyApplicationTemplates(sub);
  const have = new Set(current.map((row) => row.libraryFormId).filter((id): id is string => Boolean(id)));
  const kept = current.filter((row) => !row.libraryFormId || pickedIds.has(row.libraryFormId));
  const add = library.applications.filter((form) => pickedIds.has(form.id) && !have.has(form.id));
  // The lease a library application maps to follows onto the property's copy of that lease, when it has one.
  const leaseCopyIdByLibraryId = new Map(
    readPropertyLeaseTemplates(sub)
      .filter((row) => row.libraryFormId)
      .map((row) => [row.libraryFormId as string, row.id] as const),
  );
  const copies = add.map((form) => copyApplicationForProperty(form, leaseCopyIdByLibraryId, now));
  const next = [...kept, ...copies];
  return {
    sub: withPropertyApplicationTemplatesExplicit(sub, next),
    addedApplicationIds: copies.map((copy) => copy.id),
    added: add.length,
    removed: current.length - kept.length,
  };
}

/**
 * Push a library form's current definition onto the property's linked copy. Everything the
 * property decides for itself (its template id, which lease and co-signer form it links, the
 * fee overrides) stays; the questions, the name, the lease types and the tour order follow the library.
 */
export function syncLibraryFormIntoProperty(
  sub: ManagerListingSubmissionV1,
  kind: LeasingFormKind,
  form: PropertyApplicationTemplate | PropertyLeaseTemplate,
  now = new Date().toISOString(),
): ManagerListingSubmissionV1 {
  if (kind === "lease") {
    const source = form as PropertyLeaseTemplate;
    const next = readPropertyLeaseTemplates(sub).map((row) =>
      row.libraryFormId !== source.id
        ? row
        : {
            ...structuredClone(source),
            id: row.id,
            libraryFormId: source.id,
            listingSeedKey: row.listingSeedKey,
            linkedApplicationTemplateId: row.linkedApplicationTemplateId,
            linkedGuarantorLeaseTemplateId: row.linkedGuarantorLeaseTemplateId,
            offered: row.offered,
            createdAt: row.createdAt,
            updatedAt: now,
          },
    );
    return syncLegacyLeaseFieldsFromTemplates(sub, next);
  }
  const source = form as PropertyApplicationTemplate;
  const draft = draftQuestionConfigForTemplate(source);
  const next = readPropertyApplicationTemplates(sub).map((row) =>
    row.libraryFormId !== source.id
      ? row
      : {
          ...row,
          label: source.label,
          kind: source.kind,
          formVariant: source.formVariant,
          applicationLeaseTerms: source.applicationLeaseTerms,
          tourOrder: source.tourOrder,
          draftQuestionConfig: draft ? { ...structuredClone(draft), importProvenance: undefined } : row.draftQuestionConfig,
          updatedAt: now,
        },
  );
  return withPropertyApplicationTemplatesExplicit(sub, next);
}

/** The property's copies of a library form, for the publish step after a push. */
export function propertyCopiesOfLibraryForm(
  sub: ManagerListingSubmissionV1,
  libraryId: string,
): PropertyApplicationTemplate[] {
  return readPropertyApplicationTemplates(sub).filter((row) => row.libraryFormId === libraryId);
}

/** Filter by the search box: name, source and lease type. */
export function filterLibraryForms<T extends PropertyApplicationTemplate | PropertyLeaseTemplate>(
  kind: LeasingFormKind,
  forms: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...forms];
  return forms.filter((form) => {
    const facts = libraryFormFacts(kind, form, 0);
    return [form.label, facts.startSource, ...facts.leaseTypes].some((part) => part.toLowerCase().includes(needle));
  });
}
