import "server-only";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedSensitiveValue } from "./data-encryption";

const FIELDS = ["ssn", "dob", "dlNumber"] as const;
const METADATA = "_identityProtection";
type Protection = { version: 1; originOwnerId: string };

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid protected co-signer record.");
  return raw as Record<string, unknown>;
}

function protection(raw: Record<string, unknown>): Protection | null {
  if (raw[METADATA] === undefined) return null;
  const meta = object(raw[METADATA]);
  if (meta.version !== 1 || typeof meta.originOwnerId !== "string" || !meta.originOwnerId.trim()) {
    throw new Error("Invalid protected co-signer record.");
  }
  return { version: 1, originOwnerId: meta.originOwnerId };
}

function context(recordId: string, originOwnerId: string, field: string) {
  return { purpose: "cosigner-identity", ownerId: originOwnerId, recordId, field };
}

/** This metadata binds ciphertext, NEVER authorizes a viewer. Ownership may transfer. */
export function cosignerEncryptionOwner(raw: unknown, trustedCurrentOwner: string | null): string {
  const origin = protection(object(raw))?.originOwnerId ?? trustedCurrentOwner;
  if (!origin?.trim()) throw new Error("Co-signer encryption owner is unavailable.");
  return origin;
}

/** Caller MUST authorize against the current parent application before opening. */
export function openCosignerIdentity(raw: unknown, recordId: string, allowLegacy = process.env.COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS !== "true"): CosignerSubmission {
  if (!recordId.trim()) throw new Error("Invalid protected co-signer record.");
  const stored = object(raw);
  const meta = protection(stored);
  const value = { ...stored };
  delete value[METADATA];
  for (const field of FIELDS) {
    const token = value[field];
    if (token == null || token === "") continue;
    if (typeof token !== "string") throw new Error("Invalid protected co-signer record.");
    if (meta) {
      value[field] = decryptSensitiveValue(token, context(recordId, meta.originOwnerId, field));
    } else if (!allowLegacy || isEncryptedSensitiveValue(token)) {
      throw new Error("Unmigrated or invalid co-signer identity.");
    }
  }
  return value as CosignerSubmission;
}

/** Trusted server metadata only. Public input is reconstructed before this boundary. */
export function sealCosignerIdentity(submission: CosignerSubmission, recordId: string, originOwnerId: string): Record<string, unknown> {
  if (!recordId.trim() || !originOwnerId.trim()) throw new Error("Co-signer encryption owner is unavailable.");
  const value: Record<string, unknown> = { ...submission };
  delete value[METADATA];
  for (const field of FIELDS) {
    const token = value[field];
    if (token == null || token === "") continue;
    if (typeof token !== "string" || isEncryptedSensitiveValue(token)) throw new Error("Invalid co-signer identity input.");
    // Preserve the existing minimum-retention policy: never start storing full SSNs.
    const digits = field === "ssn" ? token.replace(/\D/g, "") : "";
    const plain = field === "ssn" ? (digits ? `***-**-${digits.slice(-4)}` : "") : token;
    value[field] = encryptSensitiveValue(plain, context(recordId, originOwnerId, field));
  }
  value[METADATA] = { version: 1, originOwnerId } satisfies Protection;
  return value;
}
