import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  draftFieldsFromLeaseSource,
  resolvePropertyLeaseSource,
  type PropertyLeaseSource,
} from "@/lib/property-lease-source";

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
  createdAt: string;
  updatedAt: string;
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
    defaultLabel: "Short-term lease",
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
  return {
    ...row,
    kind: normalizeLeaseTemplateKind(row.kind),
    leaseTemplateHtmlOverride:
      typeof row.leaseTemplateHtmlOverride === "string" ? row.leaseTemplateHtmlOverride : "",
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
