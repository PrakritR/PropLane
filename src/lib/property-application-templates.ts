import { migrateApplicationTemplateDocumentQuestions } from "@/lib/application-template-document-questions-migration";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import {
  REQUIRED_IDENTITY_STANDARD_KEYS,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";
import type { RentalApplicationSectionId } from "@/lib/rental-application/application-sections";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  normalizeLeaseTemplateKind,
  propertyLeaseTypeLabel,
  type PropertyLeaseListingSeedKey,
  type PropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";

/** Who an application is for: long-term residents, short-term residents, or either. */
export type ApplicationAppliesTo = "long_term" | "short_term" | "both";

export type PropertyApplicationTemplate = {
  id: string;
  kind: PropertyLeaseTemplateKind;
  label: string;
  formVariant: ApplicationFormVariant;
  applicationLeaseTerms?: string[];
  /**
   * Legacy mirror of `linkedLeaseTemplateId` (it used to be a many-to-many list). Read only by
   * `application-lease-mapping.ts` for data stored before the one-to-one rule; every save
   * collapses it to at most the one lease the application maps to.
   */
  usedForLeaseTemplateIds?: string[];
  /**
   * C2-CP9 (application first): the ONE lease this application maps to. One lease may serve many
   * applications; an application never maps to two. Set only from Settings -> Applications &
   * leases. `null`/absent = unmapped, which falls back to the property's default lease.
   */
  linkedLeaseTemplateId?: string | null;
  listingSeedKey?: PropertyLeaseListingSeedKey;
  createdAt: string;
  updatedAt: string;
  /**
   * Manager-only application configuration. Draft edits never reach an
   * applicant; `publishedQuestionConfig` is the snapshot a new application
   * pins. Keeping both on the named template prevents same-variant templates
   * from overwriting one another through the legacy listing-wide fields.
   */
  draftQuestionConfig?: ApplicationTemplateQuestionConfig;
  publishedQuestionConfig?: ApplicationTemplateQuestionConfig;
  /** Immutable prior published snapshots needed by in-progress applicant pins. */
  publishedQuestionConfigVersions?: ApplicationTemplateQuestionConfig[];
  /**
   * P003 (2026-09-27): this application's OWN fee, overriding the account
   * default (`manager-application-settings.ts`'s `applicationFeeCents`) only
   * for applicants who apply with THIS template. `null`/absent = "use the
   * account default" (the pre-existing, still-authoritative behavior); `0` is
   * a meaningful override ("this application is free"), same null-vs-zero
   * rule the account setting already uses. Resolved SERVER-SIDE, by
   * `applicationTemplateId`, in `resolveApplicationFeeProperty`
   * (`application-fee-checkout.server.ts`) — never trust a client-supplied
   * amount for either the account default or this override.
   */
  feeCentsOverride?: number | null;
  /**
   * The promo code this application advertises to waive its fee — a display
   * default only. Redemption is untouched: it still goes through the
   * existing account/property-scoped `manager_application_fee_waiver_codes`
   * lookup (`application-fee-waiver.ts`) regardless of which template the
   * applicant used. Storing it here just lets the manager see/set, per
   * application, which code they intend to advertise for it.
   */
  waiverCodeOverride?: string | null;
  /**
   * F-editor d: another of this property's application templates whose form
   * a planned co-signer fills in, instead of the property's generic default
   * cosigner form. `null`/absent = no link (today's behavior, unchanged).
   * Read by `resolveCosignerTemplateForApplication` for the co-signer invite
   * link; never set on a cosigner-variant template itself.
   */
  linkedCosignerApplicationTemplateId?: string | null;
  /**
   * When a prospect applies with this form relative to a tour: "before_tour" (apply, then book the
   * tour), "after_tour" (tour first, then apply) or "workspace" / absent = follow the workspace
   * setting (Settings -> Workspace -> Applications & leases, "Application before a tour").
   * Enforced SERVER-SIDE with the workspace setting in `application-before-tour.server.ts`.
   */
  tourOrder?: ApplicationTourOrder;
  /**
   * Set when this copy was added from the workspace Forms library (`leasing-forms-library.ts`): the
   * library form's id. The property's own forms never carry it.
   */
  libraryFormId?: string | null;
  /**
   * Whether this property asks for this application at all ("Needed" in the listing editor's
   * Application step). Absent = needed, exactly as every template saved before the switch existed.
   * Lives in the property's listing submission JSON beside the template; no schema change.
   */
  offered?: boolean;
  /**
   * Which stay this application is for (the Application step groups rows under Long term / Short term /
   * Both). Stored on the listing submission JSON; absent on every row saved before it existed, which is
   * then DERIVED on read (`applicationAppliesTo`).
   */
  appliesTo?: ApplicationAppliesTo;
  /**
   * The stays this application is the DEFAULT for: the form an applicant for that stay gets unless a sent
   * form says otherwise. Only an explicit entry changes routing; a stay with none behaves as it always did.
   */
  defaultFor?: ("long_term" | "short_term")[];
};

/** An application is needed unless the manager switched it off. */
export function isApplicationTemplateOffered(template: Pick<PropertyApplicationTemplate, "offered">): boolean {
  return template.offered !== false;
}

/** Per-form answer to "does this application come before the tour?". `workspace` = use the workspace setting. */
export type ApplicationTourOrder = "before_tour" | "after_tour" | "workspace";

export type ApplicationTemplateQuestionConfig = ApplicationConfigSlice & {
  version: number;
  /**
   * F-editor a: default sections the manager unchecked in the Sections step's
   * checklist — hidden from the Form step's accordion. Additive/optional, so
   * an absent or empty array means every default section still shows exactly
   * as before this field existed. A section containing a never-removable
   * field (identity trio, SSN/ID, income) can never fully disable its
   * questions, so the editor keeps its checklist entry locked on; this array
   * only ever lists sections the editor actually let the manager turn off.
   */
  disabledSectionIds?: RentalApplicationSectionId[];
  /** Source metadata is deliberately manager-only and excludes a storage URL. */
  importProvenance?: {
    sourceName?: string;
    sourcePath?: string;
    sourceSha256?: string;
    importedAt?: string;
    unresolvedCount?: number;
    issues?: Array<{ pageNumber: number | null; code: string; message: string }>;
    resolvedIssueIndexes?: number[];
    reviewedByUserId?: string;
    reviewedAt?: string;
    reviewedDraftFingerprint?: string;
  };
  /** L11-10: legacy photo ID / income toggles migrated into Documents questions. */
  documentsQuestionsMigrated?: boolean;
};

export type ApplicationTemplatePublishGate = { ok: true } | { ok: false; reason: string };

type LegacyQuestionConfigSource = Pick<
  ManagerListingSubmissionV1,
  | "disabledStandardApplicationKeys"
  | "customApplicationFields"
  | "applicationConfigMode"
  | "shortTermDisabledStandardApplicationKeys"
  | "shortTermCustomApplicationFields"
  | "shortTermApplicationConfigMode"
  | "cosignerDisabledStandardApplicationKeys"
  | "cosignerCustomApplicationFields"
  | "cosignerApplicationConfigMode"
> & { questionDisplayOrder?: string[]; shortTermQuestionDisplayOrder?: string[]; cosignerQuestionDisplayOrder?: string[] };

function copyQuestionConfig(config: ApplicationTemplateQuestionConfig): ApplicationTemplateQuestionConfig {
  return {
    ...config,
    disabledStandardApplicationKeys: [...config.disabledStandardApplicationKeys],
    customApplicationFields: config.customApplicationFields.map((field) => ({ ...field, options: [...field.options] })),
    questionDisplayOrder: config.questionDisplayOrder ? [...config.questionDisplayOrder] : undefined,
    disabledSectionIds: config.disabledSectionIds ? [...config.disabledSectionIds] : undefined,
    importProvenance: config.importProvenance ? { ...config.importProvenance } : undefined,
    documentsQuestionsMigrated: config.documentsQuestionsMigrated,
  };
}

/** The version applicants may receive. Legacy templates intentionally fall back upstream. */
export function publishedQuestionConfigForTemplate(
  template: PropertyApplicationTemplate,
): ApplicationTemplateQuestionConfig | null {
  return template.publishedQuestionConfig ? copyQuestionConfig(template.publishedQuestionConfig) : null;
}

/** The manager's editable configuration, falling back to the published snapshot. */
export function draftQuestionConfigForTemplate(
  template: PropertyApplicationTemplate,
): ApplicationTemplateQuestionConfig | null {
  const base = template.draftQuestionConfig
    ? copyQuestionConfig(template.draftQuestionConfig)
    : publishedQuestionConfigForTemplate(template);
  if (!base) return null;
  // Co-signer forms never carry upload questions (the identity route rejects
  // them), so the photo-ID / proof-of-income migration must not seed any.
  if (applicationFormVariantForTemplate(template) === "cosigner") return base;
  return migrateApplicationTemplateDocumentQuestions(base);
}

/** Anonymous listing payload: published form only, never drafts or source metadata. */
export function publicPropertyApplicationTemplate(template: PropertyApplicationTemplate): PropertyApplicationTemplate {
  const publishedQuestionConfig = template.publishedQuestionConfig;
  const publicTemplate = { ...template };
  delete publicTemplate.draftQuestionConfig;
  delete publicTemplate.publishedQuestionConfig;
  delete publicTemplate.publishedQuestionConfigVersions;
  if (!publishedQuestionConfig) return publicTemplate;
  const published = { ...publishedQuestionConfig };
  delete published.importProvenance;
  return {
    ...publicTemplate,
    publishedQuestionConfig: copyQuestionConfig(published),
    publishedQuestionConfigVersions: (template.publishedQuestionConfigVersions ?? []).map((version) => {
      const copy = copyQuestionConfig(version);
      delete copy.importProvenance;
      return copy;
    }),
  };
}

export function applicationTemplateQuestionConfigFromSlice(
  slice: ApplicationConfigSlice,
  previous?: ApplicationTemplateQuestionConfig | null,
  /** F-editor a: the Sections step's checklist, kept out of `ApplicationConfigSlice` — see that type's own doc comment. */
  disabledSectionIds?: RentalApplicationSectionId[],
): ApplicationTemplateQuestionConfig {
  return {
    ...slice,
    disabledStandardApplicationKeys: [...slice.disabledStandardApplicationKeys],
    customApplicationFields: slice.customApplicationFields.map((field) => ({ ...field, options: [...field.options] })),
    questionDisplayOrder: slice.questionDisplayOrder ? [...slice.questionDisplayOrder] : undefined,
    disabledSectionIds: disabledSectionIds ? [...disabledSectionIds] : previous?.disabledSectionIds ? [...previous.disabledSectionIds] : undefined,
    version: previous?.version ?? 1,
    importProvenance: previous?.importProvenance ? { ...previous.importProvenance } : undefined,
  };
}

export function applicationTemplateQuestionPublishGate(
  template: PropertyApplicationTemplate,
): ApplicationTemplatePublishGate {
  const draft = draftQuestionConfigForTemplate(template);
  if (!draft) return { ok: false, reason: "Save a question draft before publishing." };
  if (applicationFormVariantForTemplate(template) === "cosigner") {
    if (draft.customApplicationFields.some((field) => field.type === "file" || field.type === "photos")) {
      return { ok: false, reason: "Co-signer file and photo uploads are unavailable. Remove those upload questions before publishing." };
    }
  }
  if ((draft.importProvenance?.unresolvedCount ?? 0) > 0) {
    return { ok: false, reason: "Resolve every imported PDF issue before publishing." };
  }
  if (draft.importProvenance?.sourcePath && (
    !draft.importProvenance.reviewedByUserId ||
    draft.importProvenance.reviewedDraftFingerprint !== applicationDraftReviewFingerprint(draft)
  )) {
    return { ok: false, reason: "Compare and confirm the imported PDF before publishing." };
  }
  const disabled = new Set(draft.disabledStandardApplicationKeys);
  if (REQUIRED_IDENTITY_STANDARD_KEYS.some((key) => disabled.has(key))) {
    return { ok: false, reason: "Full legal name, phone, and email are required." };
  }
  if (draft.customApplicationFields.some((field) =>
    field.standardKey && REQUIRED_IDENTITY_STANDARD_KEYS.includes(field.standardKey) && field.required !== true,
  )) {
    return { ok: false, reason: "Full legal name, phone, and email must remain required." };
  }
  return { ok: true };
}

/** Exact editable-question snapshot acknowledged with the private original. */
export function applicationDraftReviewFingerprint(config: ApplicationTemplateQuestionConfig): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, ordered(entry)]));
    }
    return value;
  };
  return JSON.stringify(ordered({
    disabledStandardApplicationKeys: config.disabledStandardApplicationKeys,
    customApplicationFields: config.customApplicationFields,
    applicationConfigMode: config.applicationConfigMode,
    questionDisplayOrder: config.questionDisplayOrder ?? [],
  }));
}

/** Creates the immutable published snapshot and advances its version. */
export function publishApplicationTemplateQuestionDraft(
  template: PropertyApplicationTemplate,
): PropertyApplicationTemplate {
  const gate = applicationTemplateQuestionPublishGate(template);
  if (!gate.ok) throw new Error(gate.reason);
  const draft = draftQuestionConfigForTemplate(template);
  if (!draft) return template;
  const published: ApplicationTemplateQuestionConfig = { ...copyQuestionConfig(draft), version: (template.publishedQuestionConfig?.version ?? 0) + 1 };
  const history = [
    ...(template.publishedQuestionConfigVersions ?? []),
    ...(template.publishedQuestionConfig ? [copyQuestionConfig(template.publishedQuestionConfig)] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.version === item.version) === index);
  return {
    ...template,
    draftQuestionConfig: copyQuestionConfig(published),
    publishedQuestionConfig: published,
    publishedQuestionConfigVersions: history,
    updatedAt: nowIso(),
  };
}

/** Resolve a template config while retaining listing-wide fields for legacy templates. */
export function applicationQuestionConfigSourceForTemplate(
  template: PropertyApplicationTemplate,
  legacy: LegacyQuestionConfigSource,
): LegacyQuestionConfigSource {
  const published = publishedQuestionConfigForTemplate(template);
  if (!published) return legacy;
  const variant = applicationFormVariantForTemplate(template);
  if (variant === "short_term") {
    return { ...legacy, shortTermDisabledStandardApplicationKeys: published.disabledStandardApplicationKeys, shortTermCustomApplicationFields: published.customApplicationFields, shortTermApplicationConfigMode: published.applicationConfigMode, shortTermQuestionDisplayOrder: published.questionDisplayOrder };
  }
  if (variant === "cosigner") {
    return { ...legacy, cosignerDisabledStandardApplicationKeys: published.disabledStandardApplicationKeys, cosignerCustomApplicationFields: published.customApplicationFields, cosignerApplicationConfigMode: published.applicationConfigMode, cosignerQuestionDisplayOrder: published.questionDisplayOrder };
  }
  return { ...legacy, disabledStandardApplicationKeys: published.disabledStandardApplicationKeys, customApplicationFields: published.customApplicationFields, applicationConfigMode: published.applicationConfigMode, questionDisplayOrder: published.questionDisplayOrder };
}

/** Select only a published named template. A legacy template falls back to listing config. */
export function publishedApplicationTemplateForApplicant(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates">,
  variant: ApplicationFormVariant,
  templateId?: string | null,
): PropertyApplicationTemplate | null {
  const published = readPropertyApplicationTemplates(sub).filter(
    (template) => Boolean(template.publishedQuestionConfig) && isApplicationTemplateOffered(template),
  );
  // A template pinned by id (the form a lease maps to, C2-CP9) is honored across the standard and
  // short-term variants: a lease maps to ONE application whatever its length. A co-signer form is
  // only ever served to the co-signer variant.
  if (templateId) {
    return (
      published.find(
        (template) =>
          template.id === templateId &&
          (applicationFormVariantForTemplate(template) === variant ||
            (variant !== "cosigner" && applicationFormVariantForTemplate(template) !== "cosigner")),
      ) ?? null
    );
  }
  return published.find((template) => applicationFormVariantForTemplate(template) === variant) ?? null;
}

export function publishedQuestionConfigVersionForTemplate(
  template: PropertyApplicationTemplate,
  version?: number | null,
): ApplicationTemplateQuestionConfig | null {
  if (version == null) return publishedQuestionConfigForTemplate(template);
  const candidates = [template.publishedQuestionConfig, ...(template.publishedQuestionConfigVersions ?? [])];
  const found = candidates.find((config) => config?.version === version);
  return found ? copyQuestionConfig(found) : null;
}

export function applicationFormVariantForKind(kind: PropertyLeaseTemplateKind | string): ApplicationFormVariant {
  return normalizeLeaseTemplateKind(kind) === "short-term" ? "short_term" : "standard";
}

export function applicationFormVariantForTemplate(
  template: Pick<PropertyApplicationTemplate, "kind" | "listingSeedKey" | "formVariant">,
): ApplicationFormVariant {
  if (
    template.listingSeedKey === "cosigner" ||
    template.listingSeedKey === "cosigner-short-term" ||
    template.formVariant === "cosigner"
  ) {
    return "cosigner";
  }
  if (template.formVariant === "short_term") return "short_term";
  return applicationFormVariantForKind(template.kind);
}

export function propertyApplicationTypeLabel(kind: PropertyLeaseTemplateKind | string): string {
  return propertyLeaseTypeLabel(kind);
}

export function makePropertyApplicationTemplateId(): string {
  return `app-tpl-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createPropertyApplicationTemplate(args: {
  kind: PropertyLeaseTemplateKind;
  label?: string;
  applicationLeaseTerms?: string[];
  usedForLeaseTemplateIds?: string[];
  listingSeedKey?: PropertyLeaseListingSeedKey;
  formVariant?: ApplicationFormVariant;
}): PropertyApplicationTemplate {
  const kind = normalizeLeaseTemplateKind(args.kind);
  const kindMeta = PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === kind);
  const stamp = nowIso();
  return {
    id: makePropertyApplicationTemplateId(),
    kind,
    label: args.label?.trim() || kindMeta?.defaultLabel.replace(/ lease$/i, " application") || "Application",
    formVariant: args.formVariant ?? applicationFormVariantForKind(kind),
    applicationLeaseTerms: args.applicationLeaseTerms?.length ? [...args.applicationLeaseTerms] : undefined,
    usedForLeaseTemplateIds: args.usedForLeaseTemplateIds?.length ? [...args.usedForLeaseTemplateIds] : undefined,
    listingSeedKey: args.listingSeedKey,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function isPropertyApplicationTemplate(raw: unknown): raw is PropertyApplicationTemplate & { kind: string } {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as PropertyApplicationTemplate;
  return Boolean(row.id && row.kind && row.label);
}

const APPLIES_TO_VALUES: readonly ApplicationAppliesTo[] = ["long_term", "short_term", "both"];

function normalizeApplicationTemplate(
  row: PropertyApplicationTemplate & { kind: string },
): PropertyApplicationTemplate {
  const kind = normalizeLeaseTemplateKind(row.kind);
  const appliesTo = APPLIES_TO_VALUES.includes(row.appliesTo as ApplicationAppliesTo) ? row.appliesTo : undefined;
  const defaultFor = Array.isArray(row.defaultFor)
    ? row.defaultFor.filter((stay, i, all) => (stay === "long_term" || stay === "short_term") && all.indexOf(stay) === i)
    : undefined;
  return {
    ...row,
    appliesTo,
    defaultFor: defaultFor && defaultFor.length > 0 ? defaultFor : undefined,
    kind,
    formVariant: applicationFormVariantForTemplate({ ...row, kind }),
    usedForLeaseTemplateIds: Array.isArray(row.usedForLeaseTemplateIds)
      ? [...new Set(row.usedForLeaseTemplateIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
      : undefined,
    linkedLeaseTemplateId:
      typeof row.linkedLeaseTemplateId === "string" && row.linkedLeaseTemplateId.trim()
        ? row.linkedLeaseTemplateId.trim()
        : row.linkedLeaseTemplateId === null
          ? null
          : undefined,
  };
}

export function readPropertyApplicationTemplates(
  sub: Pick<ManagerListingSubmissionV1, "propertyApplicationTemplates">,
): PropertyApplicationTemplate[] {
  if (!Array.isArray(sub.propertyApplicationTemplates)) return [];
  return sub.propertyApplicationTemplates.filter(isPropertyApplicationTemplate).map(normalizeApplicationTemplate);
}

export function syncLegacyApplicationFieldsFromTemplates(
  sub: ManagerListingSubmissionV1,
  templates: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  const hasShortTerm = templates.some((t) => t.formVariant === "short_term");
  return {
    ...sub,
    propertyApplicationTemplates: templates,
    // A short-term application implies short-term stays only until the manager has said otherwise: once
    // Basics ("Stays you offer") stored an explicit choice, a hidden short-term form never switches the
    // stay back on.
    shortTermRentalsAllowed: hasShortTerm && sub.shortTermRentalsAllowed === undefined ? true : sub.shortTermRentalsAllowed,
  };
}

export function updatePropertyApplicationTemplate(
  templates: PropertyApplicationTemplate[],
  templateId: string,
  patch: Partial<PropertyApplicationTemplate>,
): PropertyApplicationTemplate[] {
  return templates.map((row) =>
    row.id === templateId
      ? {
          ...row,
          ...patch,
          kind: patch.kind ? normalizeLeaseTemplateKind(patch.kind) : row.kind,
          formVariant: applicationFormVariantForTemplate({
            ...row,
            ...patch,
            kind: patch.kind ? normalizeLeaseTemplateKind(patch.kind) : row.kind,
          }),
          updatedAt: nowIso(),
        }
      : row,
  );
}

export function removePropertyApplicationTemplate(
  templates: PropertyApplicationTemplate[],
  templateId: string,
): PropertyApplicationTemplate[] {
  return templates.filter((row) => row.id !== templateId);
}

export function withPropertyApplicationTemplatesExplicit(
  sub: ManagerListingSubmissionV1,
  templates: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  return {
    ...syncLegacyApplicationFieldsFromTemplates(sub, templates),
    propertyApplicationTemplatesExplicit: true,
  };
}

/* ───────────────────────── who an application is for ───────────────────────── */

type StayLease = Pick<PropertyLeaseTemplate, "id" | "kind">;

/**
 * Who an application is for. An explicit `appliesTo` wins. A row saved before it existed is derived: a
 * co-signer form is for both; otherwise the kind of the lease it links to (short-term -> short term,
 * anything else -> long term); with no lease link, its own form variant / kind. Pure.
 */
export function applicationAppliesTo(
  template: Pick<PropertyApplicationTemplate, "appliesTo" | "kind" | "listingSeedKey" | "formVariant" | "linkedLeaseTemplateId">,
  leases: readonly StayLease[] = [],
): ApplicationAppliesTo {
  if (template.appliesTo && APPLIES_TO_VALUES.includes(template.appliesTo)) return template.appliesTo;
  const variant = applicationFormVariantForTemplate(template);
  if (variant === "cosigner") return "both";
  const linkedId = template.linkedLeaseTemplateId?.trim();
  const linked = linkedId ? leases.find((lease) => lease.id === linkedId) : undefined;
  if (linked) return normalizeLeaseTemplateKind(linked.kind) === "short-term" ? "short_term" : "long_term";
  return variant === "short_term" ? "short_term" : "long_term";
}

/**
 * The application an applicant for `stay` gets, when the manager SET one: the offered application of that
 * stay whose `defaultFor` names it. Null when none is explicit, which is what routing reads so a listing
 * that never chose a default behaves exactly as before.
 */
export function explicitDefaultApplicationForStay(
  templates: readonly PropertyApplicationTemplate[],
  stay: "long_term" | "short_term",
  leases: readonly StayLease[] = [],
): PropertyApplicationTemplate | null {
  return (
    templates.find(
      (row) =>
        (row.defaultFor ?? []).includes(stay) &&
        isApplicationTemplateOffered(row) &&
        applicationAppliesTo(row, leases) === stay,
    ) ?? null
  );
}

/**
 * The default of a stay for DISPLAY (the ★): the explicit one, else the first published (then first offered)
 * application of that stay. Null when the stay has no application.
 */
export function effectiveDefaultApplicationForStay(
  templates: readonly PropertyApplicationTemplate[],
  stay: "long_term" | "short_term",
  leases: readonly StayLease[] = [],
): PropertyApplicationTemplate | null {
  const explicit = explicitDefaultApplicationForStay(templates, stay, leases);
  if (explicit) return explicit;
  const inStay = templates.filter((row) => isApplicationTemplateOffered(row) && applicationAppliesTo(row, leases) === stay);
  return inStay.find((row) => Boolean(row.publishedQuestionConfig)) ?? inStay[0] ?? null;
}

/** Makes one application the default of a stay (and the only one), keeping every other row's other defaults. */
export function withApplicationDefaultForStay(
  templates: readonly PropertyApplicationTemplate[],
  id: string,
  stay: "long_term" | "short_term",
): PropertyApplicationTemplate[] {
  return templates.map((row) => {
    const rest = (row.defaultFor ?? []).filter((s) => s !== stay);
    const next = row.id === id ? [...rest, stay] : rest;
    return { ...row, defaultFor: next.length > 0 ? next : undefined };
  });
}

/**
 * Moves one application to another section. A default it held for a stay it no longer applies to is
 * dropped; a Both application is never a default.
 */
export function withApplicationAppliesTo(
  templates: readonly PropertyApplicationTemplate[],
  id: string,
  appliesTo: ApplicationAppliesTo,
): PropertyApplicationTemplate[] {
  return templates.map((row) => {
    if (row.id !== id) return row;
    const kept = (row.defaultFor ?? []).filter((stay) => stay === appliesTo);
    return { ...row, appliesTo, defaultFor: kept.length > 0 ? kept : undefined, updatedAt: nowIso() };
  });
}
