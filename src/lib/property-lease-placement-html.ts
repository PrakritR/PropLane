import type { LeaseGenerationContext } from "@/lib/generated-lease";
import { jurisdictionConfig, resolveJurisdiction } from "@/lib/lease-jurisdiction";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import type { LeaseJurisdictionTemplateConfig } from "@/lib/lease-templates/types";
import {
  applyLeaseSectionBodyEdits,
  parseLeaseHtmlSections,
} from "@/lib/lease-html-sections";
import { isEditableLeaseSection } from "@/lib/lease-section-text";
import { normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  leasePreviewContextFromSubmission,
  PROPERTY_LEASE_TEMPLATE_PLACEHOLDER,
} from "@/lib/property-lease-preview";
import { resolvePropertyLeaseTemplateForApplication } from "@/lib/property-lease-template-sync";
import {
  readPropertyLeaseTemplates,
  type PropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import { resolvePropertyLeaseSource } from "@/lib/property-lease-source";

function submissionFromTemplate(
  sub: ManagerListingSubmissionV1,
  template: Pick<
    PropertyLeaseTemplate,
    "leaseConfigMode" | "leaseCustomKind" | "customLeaseTerms" | "leaseTemplateDocUrl" | "leaseTemplateDocName"
  >,
): ManagerListingSubmissionV1 {
  return {
    ...sub,
    leaseConfigMode: template.leaseConfigMode,
    leaseCustomKind: template.leaseCustomKind,
    customLeaseTerms: template.customLeaseTerms ?? "",
    leaseTemplateDocUrl: template.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: template.leaseTemplateDocName ?? "",
  };
}

function sectionBodyEditsFromTemplateOverride(
  templateOverride: string,
  previewBaselineHtml: string,
): Record<string, string> | null {
  const overrideSections = parseLeaseHtmlSections(templateOverride);
  const baselineSections = parseLeaseHtmlSections(previewBaselineHtml);
  if (!overrideSections.length || overrideSections.length !== baselineSections.length) return null;

  const edits: Record<string, string> = {};
  for (let i = 0; i < overrideSections.length; i++) {
    const overrideSection = overrideSections[i]!;
    const baselineSection = baselineSections[i]!;
    if (overrideSection.id !== baselineSection.id) return null;
    if (overrideSection.bodyHtml.trim() === baselineSection.bodyHtml.trim()) continue;
    if (!isEditableLeaseSection(overrideSection)) continue;
    if (overrideSection.bodyHtml.includes(PROPERTY_LEASE_TEMPLATE_PLACEHOLDER)) continue;
    edits[overrideSection.id] = overrideSection.bodyHtml;
  }
  return Object.keys(edits).length ? edits : null;
}

/** True when the saved override is only the auto preview shell, not manager prose edits. */
export function templateOverrideHasManagerEdits(templateOverride: string, previewBaselineHtml: string): boolean {
  const trimmed = templateOverride.trim();
  const baseline = previewBaselineHtml.trim();
  if (!trimmed || !baseline) return Boolean(trimmed);
  if (trimmed === baseline) return false;

  const edits = sectionBodyEditsFromTemplateOverride(trimmed, baseline);
  if (edits) return true;

  // Whole-document drift with no section parity — only count it as an edit when the
  // override is not the generic preview placeholder shell.
  return !trimmed.includes(PROPERTY_LEASE_TEMPLATE_PLACEHOLDER);
}

function isLegacyStandardLeaseFormat(html: string): boolean {
  return (
    /AXIS SEATTLE HOUSING/i.test(html) ||
    /PROPLANE SEATTLE HOUSING/i.test(html) ||
    /<h1>\s*RESIDENTIAL LEASE AGREEMENT\s*<\/h1>/i.test(html) ||
    /<h2>\s*1\.\s*PARTIES\s+AND\s+PREMISES\s*<\/h2>/.test(html) ||
    /<h2>\s*6\.\s*UTILITIES\s+AND\s+SERVICES/i.test(html) ||
    /Generated ProPlane default template via ProPlane/i.test(html)
  );
}

export function isStalePropertyLeaseTemplateOverride(
  templateOverride: string,
  previewBaselineHtml: string,
  config: LeaseJurisdictionTemplateConfig,
): boolean {
  const trimmed = templateOverride.trim();
  if (!trimmed) return false;

  if (config.documentStyle === "compact_room" && isLegacyStandardLeaseFormat(trimmed)) {
    return true;
  }

  if (templateOverrideHasManagerEdits(trimmed, previewBaselineHtml)) return false;

  return trimmed === previewBaselineHtml.trim();
}

export function propertyLeasePreviewBaselineHtml(
  sub: ManagerListingSubmissionV1,
  templateKind: PropertyLeaseTemplateKind,
  template?: Pick<
    PropertyLeaseTemplate,
    "leaseConfigMode" | "leaseCustomKind" | "customLeaseTerms" | "leaseTemplateDocUrl" | "leaseTemplateDocName"
  >,
): string {
  const previewSub = template ? submissionFromTemplate(sub, template) : sub;
  const ctx = leasePreviewContextFromSubmission(previewSub, undefined, templateKind, {
    templatePreview: true,
    listingFeePreview: true,
  });
  const jurisdiction = resolveJurisdiction(ctx);
  const config = jurisdiction ? jurisdictionConfig(jurisdiction) : null;
  if (!config) return "";
  return buildLeaseHtml(ctx, config).trim();
}

export function mergePropertyLeaseTemplateEditsOntoPlacement(
  placementHtml: string,
  templateOverride: string,
  previewBaselineHtml: string,
): string {
  const edits = sectionBodyEditsFromTemplateOverride(templateOverride, previewBaselineHtml);
  if (!edits) return placementHtml;
  return applyLeaseSectionBodyEdits(placementHtml, edits);
}

function resolveTemplateKind(ctx: LeaseGenerationContext, template: PropertyLeaseTemplate): PropertyLeaseTemplateKind {
  if (template.kind === "short-term" || template.kind === "long-term") return template.kind;
  const stayShort = ctx.application.rentalType === "short_term";
  return stayShort ? "short-term" : "long-term";
}

/**
 * Build a placement lease from the live generator, then layer any manager-owned
 * section edits saved on the property template.
 */
export function buildPlacementLeaseHtml(
  ctx: LeaseGenerationContext,
  config: LeaseJurisdictionTemplateConfig,
): string {
  const placementHtml = buildLeaseHtml(ctx, config);
  if (ctx.propertyTemplatePreview) return placementHtml;

  const sub = ctx.submission ? normalizeManagerListingSubmissionV1(ctx.submission) : null;
  if (!sub) return placementHtml;

  const templates = readPropertyLeaseTemplates(sub);
  if (!templates.length) return placementHtml;

  const template = resolvePropertyLeaseTemplateForApplication(sub, ctx.application);
  if (!template) return placementHtml;

  const source = resolvePropertyLeaseSource(sub);
  if (source === "custom_format" || source === "custom_builder") return placementHtml;

  const templateKind = resolveTemplateKind(ctx, template);
  const override = template.leaseTemplateHtmlOverride?.trim();
  if (!override) return placementHtml;

  const previewBaseline = propertyLeasePreviewBaselineHtml(sub, templateKind, template);
  if (isStalePropertyLeaseTemplateOverride(override, previewBaseline, config)) {
    return placementHtml;
  }

  return mergePropertyLeaseTemplateEditsOntoPlacement(placementHtml, override, previewBaseline);
}

export function effectivePropertyLeaseTemplateHtml(args: {
  sub: ManagerListingSubmissionV1;
  template: PropertyLeaseTemplate;
  templateKind: PropertyLeaseTemplateKind;
  config: LeaseJurisdictionTemplateConfig;
}): string {
  const override = args.template.leaseTemplateHtmlOverride?.trim();
  const previewBaseline = propertyLeasePreviewBaselineHtml(args.sub, args.templateKind, args.template);
  if (!override || isStalePropertyLeaseTemplateOverride(override, previewBaseline, args.config)) {
    return previewBaseline;
  }
  return override;
}
