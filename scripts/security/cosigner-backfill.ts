import { cosignerEncryptionOwner, openCosignerIdentity, sealCosignerIdentity } from "../../src/lib/security/cosigner-identity";

export function protectCosignerRecord(raw: unknown, recordId: string, managerUserId: string | null) {
  const submission = openCosignerIdentity(raw, recordId, true);
  const owner = cosignerEncryptionOwner(raw, managerUserId);
  const data = raw as Record<string, unknown>;
  const fields = ["ssn", "dob", "dlNumber"] as const;
  const plaintextFields = fields.filter((field) => typeof data[field] === "string" && data[field] !== "" && !String(data[field]).startsWith("proplane:")).length;
  // Opening above authenticates every field even on an otherwise idempotent run.
  const current = data._identityProtection && fields.every((field) =>
    data[field] == null || data[field] === "" || String(data[field]).startsWith(`proplane:v1:${process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID}:`));
  if (current) return { changed: false, plaintextFields, value: data };
  return { changed: true, plaintextFields, value: sealCosignerIdentity(submission, recordId, owner) };
}
