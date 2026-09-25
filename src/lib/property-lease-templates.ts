import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  draftFieldsFromLeaseSource,
  resolvePropertyLeaseSource,
  type PropertyLeaseSource,
} from "@/lib/property-lease-source";
import type { ApplicationConfigSlice } from "@/lib/rental-application/application-field-catalog";
// Type-only: `property-application-templates.ts` imports VALUES from this
// module, so a value-level import back would be circular. `import type` is
// erased at build time and carries no runtime dependency either way — this
// reuses that module's question-config shape exactly (see its own doc
// comment) rather than inventing a second one, since the lease and
// application editors are meant to share one question-editor UI.
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";

/** Standard PropLane lease formats — plus custom builder. */
export type PropertyLeaseTemplateKind = "short-term" | "long-term" | "time-based" | "custom";

/** Legacy stored values — normalized on read. */
type LegacyLeaseTemplateKind =
  | "standard"
  | "room-rental"
  | "month-to-month"
  | "sublease"
  | "corporate-furnished";

export type StoredPropertyLeaseTemplateKind = PropertyLeaseTemplateKind | LegacyLeaseTemplateKind;

export type PropertyLeaseListingSeedKey =
  | "fixed-term"
  | "fixed-3-month"
  | "fixed-9-month"
  | "fixed-12-month"
  | "month-to-month"
  | "short-term"
  | "custom-term"
  | "primary"
  | "bundle-primary"
  | "bundle-short-term"
  | "cosigner"
  | "cosigner-short-term";

export type PropertyLeaseTemplate = {
  id: string;
  kind: PropertyLeaseTemplateKind;
  /** Manager-facing label shown in the property lease list. */
  label: string;
  /** When auto-created from listing offered terms, stable key for merge/sync. */
  listingSeedKey?: PropertyLeaseListingSeedKey;
  /** Application lease-term choices that route applicants to this template. */
  applicationLeaseTerms?: string[];
  leaseConfigMode: "standard" | "custom";
  leaseCustomKind: "terms" | "document" | "builder";
  customLeaseTerms: string;
  leaseTemplateDocUrl: string | null;
  leaseTemplateDocName: string;
  /** Manager-edited full HTML override for this template (PropLane default or uploaded shell). */
  leaseTemplateHtmlOverride?: string;
  /** Manager review receipt for a PDF-derived conversion, pinned to exact source and HTML bytes. */
  leaseTemplateImportReview?: {
    sourceSha256: string;
    convertedHtmlSha256: string;
    reviewedAtIso: string;
    templateVersion: string;
    issueCodes: string[];
    resolvedIssueCodes?: string[];
    extractedCharacters: number;
    representedCharacters: number;
  };
  createdAt: string;
  updatedAt: string;
  /**
   * Manager-only lease-document question configuration, imported from a lease
   * PDF and reviewed through the same draft/publish machinery as
   * `PropertyApplicationTemplate` (see `property-application-templates.ts`).
   * Draft edits never reach a resident; `publishedQuestionConfig` is the
   * snapshot a signable lease would pin. Out of scope for this change: no
   * resident-facing signing wizard reads these yet.
   */
  draftQuestionConfig?: ApplicationTemplateQuestionConfig;
  publishedQuestionConfig?: ApplicationTemplateQuestionConfig;
  /** Immutable prior published snapshots, mirroring the application template's history list. */
  publishedQuestionConfigVersions?: ApplicationTemplateQuestionConfig[];
};

export const PROPERTY_LEASE_TYPE_OPTIONS: readonly {
  id: PropertyLeaseTemplateKind;
  label: string;
  description: string;
  defaultLabel: string;
}[] = [
  {
    id: "short-term",
    label: "Short-term",
    description: "Guest or furnished stay with check-in/out dates and nightly or stay-total rent.",
    defaultLabel: "Short-term stay lease",
  },
  {
    id: "long-term",
    label: "Long-term",
    description: "Standard fixed-term or month-to-month tenancy generated from the approved application.",
    defaultLabel: "Long-term lease",
  },
  {
    id: "time-based",
    label: "Time-based",
    description: "Hourly or shift-based occupancy with time-metered rent and flexible schedules.",
    defaultLabel: "Time-based lease",
  },
  {
    id: "custom",
    label: "Custom builder",
    description: "Build your own lease from a blank PropLane shell — add sections and clauses yourself.",
    defaultLabel: "Custom lease",
  },
] as const;

/** @deprecated Use PROPERTY_LEASE_TYPE_OPTIONS */
export const PROPERTY_LEASE_TEMPLATE_KIND_OPTIONS = PROPERTY_LEASE_TYPE_OPTIONS;

const LEGACY_LEASE_KIND_MAP: Record<LegacyLeaseTemplateKind, PropertyLeaseTemplateKind> = {
  standard: "long-term",
  "room-rental": "long-term",
  "month-to-month": "long-term",
  sublease: "long-term",
  "corporate-furnished": "long-term",
};

export function normalizeLeaseTemplateKind(kind: string | undefined | null): PropertyLeaseTemplateKind {
  if (!kind) return "long-term";
  if (kind in LEGACY_LEASE_KIND_MAP) return LEGACY_LEASE_KIND_MAP[kind as LegacyLeaseTemplateKind];
  if (PROPERTY_LEASE_TYPE_OPTIONS.some((o) => o.id === kind)) {
    return kind as PropertyLeaseTemplateKind;
  }
  return "long-term";
}

export function propertyLeaseTypeLabel(kind: string | undefined | null): string {
  const normalized = normalizeLeaseTemplateKind(kind);
  return PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === normalized)?.label ?? "Long-term";
}

export function makePropertyLeaseTemplateId(): string {
  return `lease-tpl-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function propertyLeaseSourceFromTemplate(
  template: Pick<PropertyLeaseTemplate, "leaseConfigMode" | "leaseCustomKind">,
): PropertyLeaseSource {
  return resolvePropertyLeaseSource(template);
}

export function createPropertyLeaseTemplate(args: {
  kind: PropertyLeaseTemplateKind;
  label?: string;
  source: PropertyLeaseSource;
  customLeaseTerms?: string;
  leaseTemplateDocUrl?: string | null;
  leaseTemplateDocName?: string;
  listingSeedKey?: PropertyLeaseListingSeedKey;
  applicationLeaseTerms?: string[];
}): PropertyLeaseTemplate {
  const kindMeta = PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === args.kind);
  const sourceFields = draftFieldsFromLeaseSource(args.source);
  const stamp = nowIso();
  return {
    id: makePropertyLeaseTemplateId(),
    kind: args.kind,
    label: args.label?.trim() || kindMeta?.defaultLabel || "Lease",
    leaseConfigMode: sourceFields.leaseConfigMode ?? "standard",
    leaseCustomKind: sourceFields.leaseCustomKind ?? "terms",
    customLeaseTerms: args.customLeaseTerms?.trim() ?? "",
    leaseTemplateDocUrl: args.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: args.leaseTemplateDocName?.trim() ?? "",
    leaseTemplateHtmlOverride: "",
    listingSeedKey: args.listingSeedKey,
    applicationLeaseTerms: args.applicationLeaseTerms?.length ? [...args.applicationLeaseTerms] : undefined,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function isPropertyLeaseTemplate(raw: unknown): raw is PropertyLeaseTemplate & { kind: string } {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as PropertyLeaseTemplate;
  return Boolean(row.id && row.kind && row.label);
}

function normalizeTemplate(row: PropertyLeaseTemplate & { kind: string }): PropertyLeaseTemplate {
  const review = row.leaseTemplateImportReview;
  const leaseTemplateImportReview =
    review &&
    /^[0-9a-f]{64}$/i.test(review.sourceSha256) &&
    /^[0-9a-f]{64}$/i.test(review.convertedHtmlSha256) &&
    typeof review.reviewedAtIso === "string" &&
    typeof review.templateVersion === "string"
      ? {
          sourceSha256: review.sourceSha256.toLowerCase(),
          convertedHtmlSha256: review.convertedHtmlSha256.toLowerCase(),
          reviewedAtIso: review.reviewedAtIso,
          templateVersion: review.templateVersion.slice(0, 200),
          issueCodes: Array.isArray(review.issueCodes)
            ? review.issueCodes.filter((code) => typeof code === "string").map((code) => code.slice(0, 80)).slice(0, 120)
            : [],
          resolvedIssueCodes: Array.isArray(review.resolvedIssueCodes)
            ? [...new Set(review.resolvedIssueCodes.filter((code) => typeof code === "string").map((code) => code.slice(0, 80)))].slice(0, 120)
            : [],
          extractedCharacters: Number.isFinite(review.extractedCharacters) ? Math.max(0, review.extractedCharacters) : 0,
          representedCharacters: Number.isFinite(review.representedCharacters) ? Math.max(0, review.representedCharacters) : 0,
        }
      : undefined;
  return {
    ...row,
    kind: normalizeLeaseTemplateKind(row.kind),
    leaseTemplateHtmlOverride:
      typeof row.leaseTemplateHtmlOverride === "string" ? row.leaseTemplateHtmlOverride : "",
    leaseTemplateImportReview,
  };
}

/** Migrate legacy single lease fields into a template list when needed. */
export function readPropertyLeaseTemplates(
  sub: Pick<
    ManagerListingSubmissionV1,
    | "propertyLeaseTemplates"
    | "leaseConfigMode"
    | "leaseCustomKind"
    | "customLeaseTerms"
    | "leaseTemplateDocUrl"
    | "leaseTemplateDocName"
  >,
): PropertyLeaseTemplate[] {
  if (Array.isArray(sub.propertyLeaseTemplates)) {
    const rows = sub.propertyLeaseTemplates.filter(isPropertyLeaseTemplate).map(normalizeTemplate);
    if (rows.length > 0) return rows;
  }

  // An empty list is a REAL state — a property with no lease templates. This
  // reader used to fabricate a "Primary lease" whenever the array was empty,
  // which is why every property appeared to have one and why deleting the last
  // template could never stick.
  //
  // The fabrication survives only where it is doing its original job: migrating
  // a legacy property that carries lease config in the pre-template fields. A
  // property with none of those has genuinely opted out, and gets [].
  const hasLegacyLeaseConfig =
    sub.leaseConfigMode === "custom" ||
    Boolean(typeof sub.customLeaseTerms === "string" && sub.customLeaseTerms.trim()) ||
    Boolean(typeof sub.leaseTemplateDocUrl === "string" && sub.leaseTemplateDocUrl.trim());
  if (!hasLegacyLeaseConfig) return [];

  const stamp = nowIso();
  return [
    {
      id: "lease-tpl-default",
      kind: "long-term",
      label: "Primary lease",
      leaseConfigMode: sub.leaseConfigMode === "custom" ? "custom" : "standard",
      leaseCustomKind:
        sub.leaseCustomKind === "document"
          ? "document"
          : sub.leaseCustomKind === "builder"
            ? "builder"
            : "terms",
      customLeaseTerms: typeof sub.customLeaseTerms === "string" ? sub.customLeaseTerms : "",
      leaseTemplateDocUrl:
        typeof sub.leaseTemplateDocUrl === "string" && sub.leaseTemplateDocUrl.trim()
          ? sub.leaseTemplateDocUrl
          : null,
      leaseTemplateDocName: typeof sub.leaseTemplateDocName === "string" ? sub.leaseTemplateDocName : "",
      leaseTemplateHtmlOverride: "",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
}

/** Keep legacy top-level lease fields in sync with the primary template for older code paths. */
export function syncLegacyLeaseFieldsFromTemplates(
  sub: ManagerListingSubmissionV1,
  templates: PropertyLeaseTemplate[],
): ManagerListingSubmissionV1 {
  const primary = templates[0];
  if (!primary) {
    return {
      ...sub,
      propertyLeaseTemplates: [],
      leaseConfigMode: "standard",
      leaseCustomKind: "terms",
      customLeaseTerms: "",
      leaseTemplateDocUrl: null,
      leaseTemplateDocName: "",
    };
  }
  return {
    ...sub,
    propertyLeaseTemplates: templates,
    leaseConfigMode: primary.leaseConfigMode,
    leaseCustomKind: primary.leaseCustomKind,
    customLeaseTerms: primary.customLeaseTerms,
    leaseTemplateDocUrl: primary.leaseTemplateDocUrl,
    leaseTemplateDocName: primary.leaseTemplateDocName,
  };
}

/** Application lease-term hint when this template is selected. */
export function templateKindLeaseTermHint(kind: PropertyLeaseTemplateKind): string | null {
  return null;
}

export function updatePropertyLeaseTemplate(
  templates: PropertyLeaseTemplate[],
  templateId: string,
  patch: Partial<PropertyLeaseTemplate>,
): PropertyLeaseTemplate[] {
  return templates.map((row) =>
    row.id === templateId
      ? {
          ...row,
          ...patch,
          kind: patch.kind ? normalizeLeaseTemplateKind(patch.kind) : row.kind,
          updatedAt: nowIso(),
        }
      : row,
  );
}

export function removePropertyLeaseTemplate(
  templates: PropertyLeaseTemplate[],
  templateId: string,
): PropertyLeaseTemplate[] {
  return templates.filter((row) => row.id !== templateId);
}

// --- Lease-document question config: draft/publish, mirroring
// property-application-templates.ts's ApplicationTemplateQuestionConfig
// machinery so both editors share one question-editor UI and one publish
// contract. Kept local (not re-exported functions from that module) because
// this module cannot import VALUES from it without a circular dependency —
// see the `import type` note above.

export type LeaseTemplatePublishGate = { ok: true } | { ok: false; reason: string };

function copyLeaseQuestionConfig(config: ApplicationTemplateQuestionConfig): ApplicationTemplateQuestionConfig {
  return {
    ...config,
    disabledStandardApplicationKeys: [...config.disabledStandardApplicationKeys],
    customApplicationFields: config.customApplicationFields.map((field) => ({ ...field, options: [...field.options] })),
    questionDisplayOrder: config.questionDisplayOrder ? [...config.questionDisplayOrder] : undefined,
    importProvenance: config.importProvenance ? { ...config.importProvenance } : undefined,
  };
}

/** The version a signable lease may pin. Legacy templates with no publish resolve to null. */
export function publishedLeaseQuestionConfigForTemplate(
  template: PropertyLeaseTemplate,
): ApplicationTemplateQuestionConfig | null {
  return template.publishedQuestionConfig ? copyLeaseQuestionConfig(template.publishedQuestionConfig) : null;
}

/** The manager's editable configuration, falling back to the published snapshot. */
export function draftLeaseQuestionConfigForTemplate(
  template: PropertyLeaseTemplate,
): ApplicationTemplateQuestionConfig | null {
  return template.draftQuestionConfig
    ? copyLeaseQuestionConfig(template.draftQuestionConfig)
    : publishedLeaseQuestionConfigForTemplate(template);
}

export function leaseTemplateQuestionConfigFromSlice(
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

/** Exact editable-question snapshot acknowledged with the private original. */
export function leaseDraftReviewFingerprint(config: ApplicationTemplateQuestionConfig): string {
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

/**
 * Unlike the application template's gate, there is no required-identity set
 * to enforce here (a lease has no standard question catalog) — only that a
 * draft exists and, when it was imported, that its exact PDF reading was
 * reviewed and every reported issue resolved.
 */
export function leaseTemplateQuestionPublishGate(template: PropertyLeaseTemplate): LeaseTemplatePublishGate {
  const draft = draftLeaseQuestionConfigForTemplate(template);
  if (!draft) return { ok: false, reason: "Save a question draft before publishing." };
  if ((draft.importProvenance?.unresolvedCount ?? 0) > 0) {
    return { ok: false, reason: "Resolve every imported PDF issue before publishing." };
  }
  if (draft.importProvenance?.sourcePath && (
    !draft.importProvenance.reviewedByUserId ||
    draft.importProvenance.reviewedDraftFingerprint !== leaseDraftReviewFingerprint(draft)
  )) {
    return { ok: false, reason: "Compare and confirm the imported PDF before publishing." };
  }
  return { ok: true };
}

/** Creates the immutable published snapshot and advances its version. */
export function publishLeaseTemplateQuestionDraft(template: PropertyLeaseTemplate): PropertyLeaseTemplate {
  const gate = leaseTemplateQuestionPublishGate(template);
  if (!gate.ok) throw new Error(gate.reason);
  const draft = draftLeaseQuestionConfigForTemplate(template);
  if (!draft) return template;
  const published: ApplicationTemplateQuestionConfig = { ...copyLeaseQuestionConfig(draft), version: (template.publishedQuestionConfig?.version ?? 0) + 1 };
  const history = [
    ...(template.publishedQuestionConfigVersions ?? []),
    ...(template.publishedQuestionConfig ? [copyLeaseQuestionConfig(template.publishedQuestionConfig)] : []),
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.version === item.version) === index);
  return {
    ...template,
    draftQuestionConfig: copyLeaseQuestionConfig(published),
    publishedQuestionConfig: published,
    publishedQuestionConfigVersions: history,
    updatedAt: nowIso(),
  };
}

export function publishedLeaseQuestionConfigVersionForTemplate(
  template: PropertyLeaseTemplate,
  version?: number | null,
): ApplicationTemplateQuestionConfig | null {
  if (version == null) return publishedLeaseQuestionConfigForTemplate(template);
  const candidates = [template.publishedQuestionConfig, ...(template.publishedQuestionConfigVersions ?? [])];
  const found = candidates.find((config) => config?.version === version);
  return found ? copyLeaseQuestionConfig(found) : null;
}
