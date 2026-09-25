import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";
import {
  REQUIRED_IDENTITY_STANDARD_KEYS,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  normalizeLeaseTemplateKind,
  propertyLeaseTypeLabel,
  type PropertyLeaseListingSeedKey,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";

export type PropertyApplicationTemplate = {
  id: string;
  kind: PropertyLeaseTemplateKind;
  label: string;
  formVariant: ApplicationFormVariant;
  applicationLeaseTerms?: string[];
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
};

export type ApplicationTemplateQuestionConfig = ApplicationConfigSlice & {
  version: number;
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
    importProvenance: config.importProvenance ? { ...config.importProvenance } : undefined,
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
  return template.draftQuestionConfig
    ? copyQuestionConfig(template.draftQuestionConfig)
    : publishedQuestionConfigForTemplate(template);
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
): ApplicationTemplateQuestionConfig {
  return {
    ...slice,
    disabledStandardApplicationKeys: [...slice.disabledStandardApplicationKeys],
    customApplicationFields: slice.customApplicationFields.map((field) => ({ ...field, options: [...field.options] })),
    questionDisplayOrder: slice.questionDisplayOrder ? [...slice.questionDisplayOrder] : undefined,
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
  const templates = readPropertyApplicationTemplates(sub).filter((template) =>
    applicationFormVariantForTemplate(template) === variant && Boolean(template.publishedQuestionConfig),
  );
  if (templateId) return templates.find((template) => template.id === templateId) ?? null;
  return templates[0] ?? null;
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

function normalizeApplicationTemplate(
  row: PropertyApplicationTemplate & { kind: string },
): PropertyApplicationTemplate {
  const kind = normalizeLeaseTemplateKind(row.kind);
  return {
    ...row,
    kind,
    formVariant: applicationFormVariantForTemplate({ ...row, kind }),
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
    shortTermRentalsAllowed: hasShortTerm ? true : sub.shortTermRentalsAllowed,
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
