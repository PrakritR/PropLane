import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates, type PropertyApplicationTemplate } from "@/lib/property-application-templates";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function importProvenanceFor(template: PropertyApplicationTemplate) {
  return template.draftQuestionConfig?.importProvenance ??
    template.publishedQuestionConfig?.importProvenance ??
    [...(template.publishedQuestionConfigVersions ?? [])].reverse().find((config) => config.importProvenance)?.importProvenance;
}

function hasImportedSource(template: PropertyApplicationTemplate): boolean {
  return Boolean(importProvenanceFor(template)?.sourcePath);
}

/**
 * Generic property saves may edit questions, but publication history, template
 * identity, and imported-source review evidence remain server-owned. Preserve
 * them even when a client sends a partial or malformed property payload.
 */
export function preserveServerOwnedApplicationVersions(
  incoming: unknown,
  stored: unknown,
): unknown {
  const previous = objectRecord(stored);
  const previousSubmission = objectRecord(previous?.listingSubmission);
  const priorTemplates = previousSubmission
    ? readPropertyApplicationTemplates(previousSubmission as unknown as ManagerListingSubmissionV1)
    : [];
  const protectedTemplates = priorTemplates.filter((template) =>
    Boolean(template.publishedQuestionConfig || template.publishedQuestionConfigVersions?.length || hasImportedSource(template)),
  );

  const next = objectRecord(incoming);
  if (!next) return protectedTemplates.length > 0 ? stored : incoming;

  const nextSubmission = objectRecord(next.listingSubmission);
  if (!nextSubmission) {
    if (protectedTemplates.length === 0) return incoming;
    return { ...next, listingSubmission: previousSubmission };
  }

  const submitted = readPropertyApplicationTemplates(nextSubmission as unknown as ManagerListingSubmissionV1);
  const priorById = new Map(priorTemplates.map((item) => [item.id, item]));
  const submittedIds = new Set(submitted.map((item) => item.id));
  const result: PropertyApplicationTemplate[] = submitted.map((template) => {
    const prior = priorById.get(template.id);
    if (!prior) {
      const { publishedQuestionConfig: _published, publishedQuestionConfigVersions: _history, ...draftOnly } = template;
      return {
        ...draftOnly,
        // Import provenance and its review receipt are created only by the
        // owner-scoped import route after it stores and reads the PDF.
        draftQuestionConfig: draftOnly.draftQuestionConfig
          ? { ...draftOnly.draftQuestionConfig, importProvenance: undefined }
          : draftOnly.draftQuestionConfig,
      };
    }

    const hadPublishedHistory = Boolean(prior.publishedQuestionConfig || prior.publishedQuestionConfigVersions?.length);
    const incomingDraft = template.draftQuestionConfig;
    const priorDraft = prior.draftQuestionConfig;
    const priorImportProvenance = importProvenanceFor(prior);
    const shouldRestoreImportedDraft = hasImportedSource(prior) && !incomingDraft;
    const draftQuestionConfig = shouldRestoreImportedDraft
      ? priorDraft
        ? { ...priorDraft, importProvenance: priorImportProvenance }
        : priorDraft
      : incomingDraft
        ? {
            ...incomingDraft,
            importProvenance: priorImportProvenance,
          }
        : incomingDraft;

    return {
      ...template,
      // These values define the target of existing applicant pins and source
      // receipts. A generic save may rename a template, but cannot retarget it.
      ...(hadPublishedHistory ? {
        id: prior.id,
        kind: prior.kind,
        formVariant: prior.formVariant,
        applicationLeaseTerms: prior.applicationLeaseTerms,
        listingSeedKey: prior.listingSeedKey,
      } : {}),
      draftQuestionConfig,
      publishedQuestionConfig: prior.publishedQuestionConfig,
      publishedQuestionConfigVersions: prior.publishedQuestionConfigVersions,
    };
  });

  // Published and imported templates cannot be deleted by a generic save. This
  // also makes deleting then recreating an imported draft with the same id
  // unable to shed its source receipt.
  for (const prior of protectedTemplates) {
    if (!submittedIds.has(prior.id)) result.push(prior);
  }

  return {
    ...next,
    listingSubmission: {
      ...nextSubmission,
      propertyApplicationTemplates: result,
    },
  };
}
