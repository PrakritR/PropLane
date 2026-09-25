import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  assessCosignerSignerApplication,
  type CosignerSignerLinkPreview,
  validateCosignerSignerAppIdInput,
} from "@/lib/rental-application/cosigner-signer-link";
import { resolveCosignerTemplateForApplication } from "./cosigner-template.server";

function rowFromRecord(record: { id: string; row_data: unknown; property_id?: string | null } | null): Pick<
  DemoApplicantRow,
  "id" | "name" | "propertyId" | "application" | "bucket" | "stage" | "withdrawnAt" | "property"
> | null {
  if (!record?.row_data) return null;
  const row = record.row_data as DemoApplicantRow;
  const propertyId =
    row.propertyId?.trim() ||
    (typeof record.property_id === "string" ? record.property_id.trim() : "") ||
    row.application?.propertyId?.trim() ||
    undefined;
  return {
    id: record.id,
    name: row.name,
    property: row.property,
    propertyId,
    application: row.application,
    bucket: row.bucket,
    stage: row.stage,
    withdrawnAt: row.withdrawnAt,
  };
}

export async function loadCosignerSignerLinkPreview(
  db: SupabaseClient,
  signerAppId: string,
  templateId?: string,
  templateVersion?: number,
): Promise<CosignerSignerLinkPreview> {
  const validated = validateCosignerSignerAppIdInput(signerAppId);
  if (!validated.ok) {
    return { ok: false, code: "invalid_id", message: validated.message };
  }

  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data, property_id, manager_user_id")
    .eq("id", validated.normalized)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      code: "not_found",
      message: "Could not look up that application right now. Try again in a moment.",
    };
  }

  if (!data) {
    return assessCosignerSignerApplication(validated.normalized, null);
  }

  const preview = assessCosignerSignerApplication(validated.normalized, rowFromRecord(data));
  if (!preview.ok) return preview;
  const template = await resolveCosignerTemplateForApplication(db, data, templateId, templateVersion);
  if (!template || template.pinMissing) return { ok: false, code: "not_found", message: "This co-signer form is unavailable. Ask the manager for a new link." };
  return { ...preview, applicationConfig: template.config, applicationTemplateId: template.templateId, applicationTemplateVersion: template.templateVersion };
}
