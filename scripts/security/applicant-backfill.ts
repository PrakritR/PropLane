import { openApplicantRow, sealApplicantRow } from "../../src/lib/security/applicant-identity";

export function protectApplicantRecord(raw: unknown, recordId: string, managerUserId: string | null) {
  const opened = openApplicantRow(raw, recordId, true);
  const data = raw as Record<string, unknown>;
  const application = data.application as Record<string, unknown> | undefined;
  const fields = ["ssn", "dateOfBirth", "driversLicense"] as const;
  const plaintextFields = fields.filter((field) => typeof application?.[field] === "string" && application[field] !== "").length;
  const meta = data._applicantIdentity as { originOwnerId?: string; ciphertext?: string } | undefined;
  // Opening validates all existing ciphertext before an idempotent result.
  const current = meta?.ciphertext?.startsWith(`proplane:v1:${process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID}:`);
  if (current || (!meta && !plaintextFields)) return { changed: false, plaintextFields, value: data };
  return { changed: true, plaintextFields, value: sealApplicantRow(opened, recordId, meta?.originOwnerId || managerUserId) };
}
