import type { DemoApplicantRow } from "@/data/demo-portal";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { applicationLinkBlock } from "@/lib/rental-application/application-link-eligibility";
import { validateGroupLeaderAppIdInput } from "@/lib/rental-application/group-leader-link";
import type { ApplicationConfigSlice } from "./application-field-catalog";

export type CosignerSignerLinkOk = {
  ok: true;
  signerAppId: string;
  signerFullName: string | null;
  propertyId: string | null;
  applicationConfig?: ApplicationConfigSlice;
  applicationTemplateId?: string;
  applicationTemplateVersion?: number;
};

export type CosignerSignerLinkErrorCode = "invalid_id" | "not_found" | "not_submitted";

export type CosignerSignerLinkError = {
  ok: false;
  code: CosignerSignerLinkErrorCode;
  message: string;
};

export type CosignerSignerLinkPreview = CosignerSignerLinkOk | CosignerSignerLinkError;

export function validateCosignerSignerAppIdInput(
  id: string,
): { ok: true; normalized: string } | { ok: false; message: string } {
  return validateGroupLeaderAppIdInput(id);
}

/** Read-only preview for a co-signer invite link — no PII beyond the signer's name. */
export function assessCosignerSignerApplication(
  signerAppId: string,
  row: Pick<DemoApplicantRow, "id" | "name" | "propertyId" | "application" | "bucket" | "stage" | "withdrawnAt" | "property"> | null | undefined,
): CosignerSignerLinkPreview {
  const validated = validateCosignerSignerAppIdInput(signerAppId);
  if (!validated.ok) {
    return { ok: false, code: "invalid_id", message: validated.message };
  }

  if (!row) {
    return {
      ok: false,
      code: "not_found",
      message: "No application found with that ID. Ask the applicant to resend their invite link.",
    };
  }

  const blocked = applicationLinkBlock(row);
  if (blocked) {
    return { ok: false, code: blocked.code, message: blocked.message };
  }

  const app = row.application;
  const name = (row.name || app?.fullLegalName || "").trim();
  const propertyId =
    row.propertyId?.trim() || app?.propertyId?.trim() || null;

  return {
    ok: true,
    signerAppId: normalizeApplicationAxisId(validated.normalized).toUpperCase(),
    signerFullName: name || null,
    propertyId,
  };
}
