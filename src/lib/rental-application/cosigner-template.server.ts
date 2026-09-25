import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationConfigForApplicant } from "./application-template-config";
import type { ApplicationConfigSlice } from "./application-field-catalog";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

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
  const resolved = applicationConfigForApplicant(submission, "cosigner", templateId, templateVersion);
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
