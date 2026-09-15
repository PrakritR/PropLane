import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";

/** Simplified property lease document picker (replaces separate source + agreement type). */
export type PropertyLeaseDocumentMode =
  | "proplane_long_term"
  | "proplane_short_term"
  | "upload";

export const PROPERTY_LEASE_DOCUMENT_MODE_OPTIONS: readonly {
  id: PropertyLeaseDocumentMode;
  label: string;
  detail: string;
}[] = [
  {
    id: "proplane_long_term",
    label: "PropLane default — long term",
    detail:
      "PropLane generates a fixed-term or month-to-month lease from the approved application and listing.",
  },
  {
    id: "proplane_short_term",
    label: "PropLane default — short-term stay",
    detail: "PropLane generates a short-stay agreement with check-in/out dates and stay-total rent.",
  },
  {
    id: "upload",
    label: "Upload your lease",
    detail:
      "Upload a PDF — PropLane parses it into editable PropPlane sections, then adds placement details and e-signatures.",
  },
] as const;

/** How the lease document is produced for a property (UI-facing source id). */
export type PropertyLeaseSource =
  | "axis_default"
  | "custom_comments"
  | "custom_format"
  | "custom_builder";

export const PROPERTY_LEASE_SOURCE_OPTIONS: readonly {
  id: PropertyLeaseSource;
  label: string;
  shortLabel: string;
  detail: string;
}[] = [
  {
    id: "axis_default",
    label: "PropLane default",
    shortLabel: "PropLane default",
    detail:
      "PropLane builds the full lease from the approved application and listing — rent, deposits, house rules, and disclosures.",
  },
  {
    id: "custom_builder",
    label: "Custom builder",
    shortLabel: "Custom builder",
    detail: "Start from a blank PropLane lease shell and add your own sections, clauses, and terms.",
  },
  {
    id: "custom_comments",
    label: "Custom clauses",
    shortLabel: "Custom clauses",
    detail:
      "Add your own provisions. PropLane attaches them to the generated lease under “Additional Provisions from Property Manager”.",
  },
  {
    id: "custom_format",
    label: "Upload your lease",
    shortLabel: "Your PDF",
    detail:
      "Upload a PDF — PropLane parses it into editable sections in PropPlane format, then adds placement details and e-signatures.",
  },
] as const;

export function resolvePropertyLeaseSource(
  sub: Pick<ManagerListingSubmissionV1, "leaseConfigMode" | "leaseCustomKind"> | null | undefined,
): PropertyLeaseSource {
  if (!sub || sub.leaseConfigMode !== "custom") return "axis_default";
  if (sub.leaseCustomKind === "document") return "custom_format";
  if (sub.leaseCustomKind === "builder") return "custom_builder";
  return "custom_comments";
}

export function propertyLeaseSourceLabel(source: PropertyLeaseSource): string {
  return PROPERTY_LEASE_SOURCE_OPTIONS.find((o) => o.id === source)?.shortLabel ?? "PropLane default";
}

export function draftFieldsFromLeaseSource(
  source: PropertyLeaseSource,
): Pick<ManagerListingSubmissionV1, "leaseConfigMode" | "leaseCustomKind"> {
  if (source === "axis_default") return { leaseConfigMode: "standard", leaseCustomKind: "terms" };
  if (source === "custom_format") return { leaseConfigMode: "custom", leaseCustomKind: "document" };
  if (source === "custom_builder") return { leaseConfigMode: "custom", leaseCustomKind: "builder" };
  return { leaseConfigMode: "custom", leaseCustomKind: "terms" };
}

export function leaseSourceFromDraft(
  draft: Pick<ManagerListingSubmissionV1, "leaseConfigMode" | "leaseCustomKind">,
): PropertyLeaseSource {
  return resolvePropertyLeaseSource(draft);
}

export function propertyLeaseDocumentModeLabel(mode: PropertyLeaseDocumentMode): string {
  return PROPERTY_LEASE_DOCUMENT_MODE_OPTIONS.find((o) => o.id === mode)?.label ?? "PropLane default — long term";
}

/** Map stored lease fields to the simplified document mode (legacy builder/clauses → PropLane long term). */
export function documentModeFromLease(
  source: PropertyLeaseSource,
  kind: PropertyLeaseTemplateKind,
): PropertyLeaseDocumentMode {
  if (source === "custom_format") return "upload";
  if (kind === "short-term") return "proplane_short_term";
  return "proplane_long_term";
}

export function applyPropertyLeaseDocumentMode(mode: PropertyLeaseDocumentMode): {
  source: PropertyLeaseSource;
  kind: PropertyLeaseTemplateKind;
  draftFields: Pick<ManagerListingSubmissionV1, "leaseConfigMode" | "leaseCustomKind">;
} {
  if (mode === "upload") {
    return {
      source: "custom_format",
      kind: "long-term",
      draftFields: draftFieldsFromLeaseSource("custom_format"),
    };
  }
  if (mode === "proplane_short_term") {
    return {
      source: "axis_default",
      kind: "short-term",
      draftFields: draftFieldsFromLeaseSource("axis_default"),
    };
  }
  return {
    source: "axis_default",
    kind: "long-term",
    draftFields: draftFieldsFromLeaseSource("axis_default"),
  };
}
