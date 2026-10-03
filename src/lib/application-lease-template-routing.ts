import type { ManagerCustomApplicationField, ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import {
  readPropertyLeaseTemplates,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import type { RentalCustomFieldAnswer, RentalWizardFormState } from "@/lib/rental-application/types";

function customAnswersFromApplication(
  application: Pick<Partial<RentalWizardFormState>, "customFieldAnswers">,
): RentalCustomFieldAnswer[] {
  const raw = application.customFieldAnswers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (row): row is RentalCustomFieldAnswer =>
      Boolean(row && typeof row === "object" && typeof (row as RentalCustomFieldAnswer).key === "string"),
  );
}

function fieldsFromSubmission(sub: ManagerListingSubmissionV1): ManagerCustomApplicationField[] {
  const listing = [
    ...(sub.customApplicationFields ?? []),
    ...(sub.shortTermCustomApplicationFields ?? []),
    ...(sub.cosignerCustomApplicationFields ?? []),
  ];
  const templates = readPropertyApplicationTemplates(sub).flatMap((t) => [
    ...(t.draftQuestionConfig?.customApplicationFields ?? []),
    ...(t.publishedQuestionConfig?.customApplicationFields ?? []),
  ]);
  return [...listing, ...templates];
}

/**
 * When an application form maps a dropdown answer to a lease template, that
 * template wins over term-based routing (studio C1-PIPE1).
 */
export function resolveLeaseTemplateIdFromApplicationAnswers(
  sub: ManagerListingSubmissionV1,
  application: Pick<Partial<RentalWizardFormState>, "customFieldAnswers">,
): string | null {
  const answers = customAnswersFromApplication(application);
  if (!answers.length) return null;
  const byKey = new Map(answers.map((a) => [a.key, a.value.trim()]));
  for (const field of fieldsFromSubmission(sub)) {
    if (field.type !== "select") continue;
    const ids = field.optionLeaseTemplateIds;
    if (!ids?.length) continue;
    const answer = byKey.get(field.key);
    if (!answer) continue;
    const idx = field.options.findIndex((opt) => opt.trim() === answer);
    if (idx < 0) continue;
    const templateId = ids[idx];
    if (templateId) return templateId;
  }
  return null;
}

export function resolvePropertyLeaseTemplateFromApplicationAnswers(
  sub: ManagerListingSubmissionV1,
  application: Pick<Partial<RentalWizardFormState>, "customFieldAnswers">,
): PropertyLeaseTemplate | null {
  const templateId = resolveLeaseTemplateIdFromApplicationAnswers(sub, application);
  if (!templateId) return null;
  return readPropertyLeaseTemplates(sub).find((t) => t.id === templateId) ?? null;
}
