import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationConfigForApplicant } from "./application-template-config";
import type { ApplicationConfigSlice } from "./application-field-catalog";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { applicationFormVariantForTemplate, readPropertyApplicationTemplates } from "@/lib/property-application-templates";

export type CosignerTemplateResolution = {
  config: ApplicationConfigSlice;
  templateId?: string;
  templateVersion?: number;
  pinMissing?: boolean;
};

/** Resolve against the primary application's owner and property, never a body-supplied listing. */
export async function resolveCosignerTemplateForApplication(
  db: SupabaseClient,
  app: { manager_user_id: string | null; property_id?: string | null; row_data: unknown },
  templateId?: string,
  templateVersion?: number,
  /**
   * Only the authorized linked-form routes set this: a linked form named by a manager's rule may be any
   * published application template of this property, not just a co-signer one. The public co-signer link
   * never passes it, so it still serves co-signer templates only.
   */
  opts?: { anyPublishedVariant?: boolean },
): Promise<CosignerTemplateResolution | null> {
  const row = app.row_data as DemoApplicantRow | null;
  const propertyId = app.property_id || row?.propertyId || row?.application?.propertyId;
  if (!app.manager_user_id || !propertyId) return null;
  const { data, error } = await db.from("manager_property_records")
    .select("property_data")
    .eq("id", propertyId)
    .eq("manager_user_id", app.manager_user_id)
    .maybeSingle();
  if (error || !data) return null;
  const propertyData = data.property_data as { listingSubmission?: ManagerListingSubmissionV1 } | null;
  const submission = propertyData?.listingSubmission;
  // F-editor d: an explicit `templateId` (a real signer link already pinned
  // to one) always wins. Otherwise, when the PRIMARY applicant's own
  // application named a "Linked co-signer form" in its Setup step, the
  // co-signer fills in THAT form rather than the property's generic default
  // cosigner template.
  let effectiveTemplateId = templateId;
  const primaryApplicationTemplateId = (row?.application as { applicationTemplateId?: string } | undefined)?.applicationTemplateId;
  if (!effectiveTemplateId && primaryApplicationTemplateId && submission) {
    const primaryTemplate = readPropertyApplicationTemplates(submission).find(
      (candidate) => candidate.id === primaryApplicationTemplateId,
    );
    if (primaryTemplate?.linkedCosignerApplicationTemplateId) {
      effectiveTemplateId = primaryTemplate.linkedCosignerApplicationTemplateId;
    }
  }
  const pinnedTemplate =
    opts?.anyPublishedVariant && effectiveTemplateId && submission
      ? readPropertyApplicationTemplates(submission).find((candidate) => candidate.id === effectiveTemplateId)
      : undefined;
  const resolved = applicationConfigForApplicant(
    submission,
    pinnedTemplate ? applicationFormVariantForTemplate(pinnedTemplate) : "cosigner",
    effectiveTemplateId,
    templateVersion,
  );
  // The link is public. Never return a published snapshot's manager-only
  // importProvenance (private source path, reviewer id, draft fingerprint).
  return {
    config: {
      applicationConfigMode: resolved.config.applicationConfigMode,
      disabledStandardApplicationKeys: [...resolved.config.disabledStandardApplicationKeys],
      customApplicationFields: resolved.config.customApplicationFields.map((field) => ({ ...field, options: [...field.options] })),
      questionDisplayOrder: resolved.config.questionDisplayOrder ? [...resolved.config.questionDisplayOrder] : undefined,
    },
    templateId: resolved.templateId,
    templateVersion: resolved.templateVersion,
    pinMissing: resolved.pinMissing,
  };
}
