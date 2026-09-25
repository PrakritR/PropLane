import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  publishedApplicationTemplateForApplicant,
  publishedQuestionConfigVersionForTemplate,
} from "@/lib/property-application-templates";
import { applicationConfigForVariant, type ApplicationConfigSlice, type ApplicationFormVariant } from "@/lib/rental-application/application-field-catalog";

/** Resolves the public form from a published template and returns its pin. */
export function applicationConfigForApplicant(
  submission: ManagerListingSubmissionV1 | null | undefined,
  variant: ApplicationFormVariant,
  templateId?: string | null,
  templateVersion?: number | null,
): { config: ApplicationConfigSlice; templateId?: string; templateVersion?: number; pinMissing?: boolean } {
  if (submission) {
    const template = publishedApplicationTemplateForApplicant(submission, variant, templateId);
    const published = template ? publishedQuestionConfigVersionForTemplate(template, templateVersion) : null;
    if (template && published) {
      return { config: published, templateId: template.id, templateVersion: published.version };
    }
  }
  return {
    config: applicationConfigForVariant(submission, variant),
    ...(templateId ? { pinMissing: true } : {}),
  };
}
