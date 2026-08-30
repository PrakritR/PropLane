import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { buildCosignerScreeningRow, cosignerShowsBackgroundCheck } from "@/lib/cosigner-screening";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import type { DemoApplicantRow } from "@/data/demo-portal";

export type ScreeningSubjectType = "signer" | "cosigner";

export type ScreeningSubject = {
  id: string;
  type: ScreeningSubjectType;
  label: string;
  consentCredit: boolean;
  backgroundCheck?: ApplicationBackgroundCheck;
  /** Set when `type === "cosigner"`. */
  cosignerSubmissionId?: string;
};

export function backgroundCheckStatusLabel(bc?: ApplicationBackgroundCheck): string {
  if (!bc) return "Not started";
  if (bc.status === "pending") return "Pending";
  if (bc.status === "complete") {
    if (bc.result === "clear") return "Clear";
    if (bc.result === "consider") return "Consider";
    return "Complete";
  }
  if (bc.status === "canceled") return "Canceled";
  return "Not started";
}

export function buildScreeningSubjects(
  signerRow: DemoApplicantRow,
  cosigners: CosignerSubmission[],
): ScreeningSubject[] {
  const subjects: ScreeningSubject[] = [];
  if (applicationShowsBackgroundCheck(signerRow)) {
    subjects.push({
      id: signerRow.id,
      type: "signer",
      label: applicantDisplayName(signerRow),
      consentCredit: Boolean(signerRow.application?.consentCredit),
      backgroundCheck: signerRow.backgroundCheck,
    });
  }
  for (const cosigner of cosigners) {
    if (!cosignerShowsBackgroundCheck(cosigner)) continue;
    const id = cosigner.id?.trim() || `cosigner-${cosigner.email}`;
    subjects.push({
      id,
      type: "cosigner",
      label: cosigner.fullName?.trim() || cosigner.email?.trim() || "Co-signer",
      consentCredit: Boolean(cosigner.consentCredit),
      backgroundCheck: cosigner.backgroundCheck,
      cosignerSubmissionId: cosigner.id,
    });
  }
  return subjects;
}

export function resolveScreeningSubjectId(
  subjects: ScreeningSubject[],
  preferredId: string | null | undefined,
  signerRowId: string,
): string {
  if (preferredId && subjects.some((s) => s.id === preferredId)) return preferredId;
  return subjects[0]?.id ?? signerRowId;
}

export function screeningRowForSubject(
  signerRow: DemoApplicantRow,
  cosigners: CosignerSubmission[],
  subjectId: string,
): DemoApplicantRow {
  if (subjectId === signerRow.id) return signerRow;
  const cosigner = cosigners.find((c) => c.id === subjectId);
  return cosigner ? buildCosignerScreeningRow(signerRow, cosigner) : signerRow;
}

export function cosignerSubmissionIdForSubject(
  subjects: ScreeningSubject[],
  subjectId: string,
): string | undefined {
  return subjects.find((s) => s.id === subjectId)?.cosignerSubmissionId;
}
