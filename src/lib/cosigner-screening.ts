import type { DemoApplicantRow } from "@/data/demo-portal";
import { backgroundCheckStatusFromCheckr } from "@/lib/application-background-check";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/** Co-signer authorized credit consent — same gate as primary applicant screening. */
export function cosignerShowsBackgroundCheck(sub: CosignerSubmission): boolean {
  return Boolean(sub.consentCredit);
}

/**
 * Synthetic applicant row for Checkr UI: keeps the signer application id for
 * property/manager scoping while displaying the co-signer's PII and check state.
 */
export function buildCosignerScreeningRow(
  signerRow: DemoApplicantRow,
  cosigner: CosignerSubmission,
): DemoApplicantRow {
  const application: RentalWizardFormState = {
    ...(signerRow.application ?? ({} as RentalWizardFormState)),
    fullLegalName: cosigner.fullName,
    email: cosigner.email,
    phone: cosigner.phone,
    dateOfBirth: cosigner.dob,
    ssn: cosigner.ssn,
    consentCredit: cosigner.consentCredit,
  };
  return {
    ...signerRow,
    name: cosigner.fullName,
    email: cosigner.email,
    application,
    backgroundCheck: cosigner.backgroundCheck,
    backgroundCheckStatus: cosigner.backgroundCheck
      ? backgroundCheckStatusFromCheckr(cosigner.backgroundCheck)
      : signerRow.backgroundCheckStatus,
  };
}

export function applyCosignerBackgroundCheck(
  sub: CosignerSubmission,
  backgroundCheck: ApplicationBackgroundCheck,
): CosignerSubmission {
  return { ...sub, backgroundCheck };
}
