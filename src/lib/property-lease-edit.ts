import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  buildPropertyLeasePreview,
  leasePreviewContextFromSubmission,
  type PropertyLeasePreviewHint,
} from "@/lib/property-lease-preview";
import { effectivePropertyLeaseTemplateHtml } from "@/lib/property-lease-placement-html";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import { jurisdictionConfig, resolveJurisdiction } from "@/lib/lease-jurisdiction";
import type { PropertyLeaseTemplate, PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { buildCustomBuilderLeaseHtml } from "@/lib/lease-pdf-parse";
import { prependLeaseHtmlSection } from "@/lib/lease-html-sections";
import type { PropertyLeaseSource } from "@/lib/property-lease-source";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** UI-facing document source — uploaded PDF vs everything else editable as HTML. */
export function normalizePropertyLeaseDocumentSource(
  source: PropertyLeaseSource,
): "axis_default" | "custom_format" | "custom_builder" {
  if (source === "custom_format") return "custom_format";
  if (source === "custom_builder") return "custom_builder";
  return "axis_default";
}

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

function draftAsTemplate(
  draft: Pick<
    PropertyLeaseTemplate,
    | "leaseConfigMode"
    | "leaseCustomKind"
    | "customLeaseTerms"
    | "leaseTemplateDocUrl"
    | "leaseTemplateDocName"
    | "leaseTemplateHtmlOverride"
  >,
  templateKind: PropertyLeaseTemplateKind,
): PropertyLeaseTemplate {
  return {
    id: "draft",
    kind: templateKind,
    label: "",
    leaseConfigMode: draft.leaseConfigMode,
    leaseCustomKind: draft.leaseCustomKind,
    customLeaseTerms: draft.customLeaseTerms ?? "",
    leaseTemplateDocUrl: draft.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: draft.leaseTemplateDocName ?? "",
    leaseTemplateHtmlOverride: draft.leaseTemplateHtmlOverride ?? "",
    createdAt: "",
    updatedAt: "",
  };
}

function appendLegacyCustomTermsSection(html: string, terms: string): string {
  const trimmed = terms.trim();
  if (!trimmed || !html.trim()) return html;
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body =
    paragraphs.length > 1
      ? paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("\n")
      : `<p>${escapeHtml(trimmed).replace(/\n/g, "<br/>")}</p>`;
  return prependLeaseHtmlSection(html, {
    title: "Additional provisions from property manager",
    bodyHtml: body,
  });
}

/** Editable HTML shell for an uploaded PDF — scan is embedded; sections can be added above. */
export function buildUploadedLeaseEditableHtml(docUrl: string, docName: string): string {
  const safeName = escapeHtml(docName.trim() || "Uploaded lease");
  const safeUrl = escapeHtml(docUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${safeName}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; color: #1f2430; margin: 0 auto; max-width: 820px; line-height: 1.55; padding: 28px 24px 40px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #d8dce4; padding-bottom: 4px; margin: 28px 0 12px; }
    p, li { font-size: 14px; }
    .note { color: #5a6172; font-size: 13px; }
    .pdf-frame { width: 100%; min-height: 520px; border: 1px solid #d8dce4; border-radius: 8px; background: #f8f9fb; }
  </style>
</head>
<body>
  <h2>1. Uploaded lease document</h2>
  <p class="note">Your scanned or PDF lease is attached below. Add or edit sections above this block — PropLane uses the full document at signing.</p>
  <iframe class="pdf-frame" title="${safeName}" src="${safeUrl}"></iframe>
  <h2>2. Placement summary</h2>
  <p>PropLane fills resident name, room, rent, and dates from the approved application when the lease is sent for signature.</p>
  <h2>3. Electronic signature</h2>
  <p>Landlord and Resident each execute this lease through the PropLane portal. The Electronic Signature Certificate is the binding record for both parties.</p>
</body>
</html>`;
}

export function resolvePropertyLeaseEditHtml(args: {
  sub: ManagerListingSubmissionV1;
  draft: Pick<
    PropertyLeaseTemplate,
    | "leaseConfigMode"
    | "leaseCustomKind"
    | "customLeaseTerms"
    | "leaseTemplateDocUrl"
    | "leaseTemplateDocName"
    | "leaseTemplateHtmlOverride"
  >;
  source: PropertyLeaseSource;
  templateKind?: PropertyLeaseTemplate["kind"];
  hint?: PropertyLeasePreviewHint;
  demo?: boolean;
}): string {
  const normalizedSource = normalizePropertyLeaseDocumentSource(args.source);
  const override = args.draft.leaseTemplateHtmlOverride?.trim();

  if (normalizedSource === "custom_format") {
    if (override) return override;
    const docUrl = args.draft.leaseTemplateDocUrl?.trim();
    if (!docUrl) return "";
    return buildUploadedLeaseEditableHtml(docUrl, args.draft.leaseTemplateDocName ?? "Uploaded lease");
  }

  if (normalizedSource === "custom_builder") {
    if (override) return override;
    return buildCustomBuilderLeaseHtml(args.draft.leaseTemplateDocName ?? "Custom lease");
  }

  const previewSub = submissionFromTemplate(args.sub, args.draft);
  const templateKind = args.templateKind ?? "long-term";

  if (override && normalizedSource === "axis_default") {
    const jurisdiction = resolveJurisdiction(
      leasePreviewContextFromSubmission(previewSub, args.hint, templateKind),
    );
    const config = jurisdiction ? jurisdictionConfig(jurisdiction) : null;
    if (config) {
      let html = stripDisclosureReviewFromLeaseHtml(
        effectivePropertyLeaseTemplateHtml({
          sub: args.sub,
          template: draftAsTemplate(args.draft, templateKind),
          templateKind,
          config,
        }),
      );
      if (args.source === "custom_comments" && args.draft.customLeaseTerms?.trim()) {
        html = appendLegacyCustomTermsSection(html, args.draft.customLeaseTerms);
      }
      return html;
    }
  }

  const preview = buildPropertyLeasePreview(previewSub, {
    hint: args.hint,
    demo: args.demo,
    templateKind,
  });
  let html = preview.html?.trim() ?? "";
  if (!html) return "";

  if (args.source === "custom_comments" && args.draft.customLeaseTerms?.trim()) {
    html = appendLegacyCustomTermsSection(html, args.draft.customLeaseTerms);
  }
  return html;
}

export function propertyLeaseTemplateDraftFromTemplate(template: PropertyLeaseTemplate): Pick<
  PropertyLeaseTemplate,
  | "leaseConfigMode"
  | "leaseCustomKind"
  | "customLeaseTerms"
  | "leaseTemplateDocUrl"
  | "leaseTemplateDocName"
  | "leaseTemplateHtmlOverride"
> {
  return {
    leaseConfigMode: template.leaseConfigMode,
    leaseCustomKind: template.leaseCustomKind,
    customLeaseTerms: template.customLeaseTerms ?? "",
    leaseTemplateDocUrl: template.leaseTemplateDocUrl ?? null,
    leaseTemplateDocName: template.leaseTemplateDocName ?? "",
    leaseTemplateHtmlOverride: template.leaseTemplateHtmlOverride ?? "",
  };
}
