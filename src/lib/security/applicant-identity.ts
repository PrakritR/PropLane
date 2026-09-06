import "server-only";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { decryptSensitiveValue, encryptSensitiveValue } from "./data-encryption";

const META = "_applicantIdentity";
const FIELDS = ["ssn", "dateOfBirth", "driversLicense"] as const;
type Identity = Record<(typeof FIELDS)[number], string>;
type Row = Record<string, unknown>;
function asObject(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function bindingId(id: string): string {
  if (!id.trim()) throw new Error("Application identity binding is required.");
  return id;
}
function context(id: string, ownerId: string) {
  return { purpose: "applicant-identity", ownerId, recordId: bindingId(id), field: "identity" };
}
function metadata(row: Row): { version: 1; originOwnerId: string; ciphertext: string } | null {
  if (row[META] === undefined) return null;
  const meta = asObject(row[META]);
  if (!meta || meta.version !== 1 || typeof meta.originOwnerId !== "string" || !meta.originOwnerId.trim() || typeof meta.ciphertext !== "string") {
    throw new Error("Invalid protected applicant identity.");
  }
  return { version: 1, originOwnerId: meta.originOwnerId, ciphertext: meta.ciphertext };
}
function identityFrom(app: Row | null): Identity {
  const result = {} as Identity;
  for (const field of FIELDS) {
    const value = app?.[field];
    if (value != null && typeof value !== "string") throw new Error("Invalid applicant identity.");
    result[field] = typeof value === "string" ? value : "";
  }
  return result;
}

/** Only call after current actor/token/property authorization. Never serialize stored rows. */
export function openApplicantRow(raw: unknown, recordId: string, allowLegacy = process.env.APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS !== "true"): DemoApplicantRow {
  const row = asObject(raw);
  if (!row) throw new Error("Invalid applicant record.");
  const app = asObject(row.application);
  const meta = metadata(row);
  const result = { ...row };
  delete result[META];
  if (!meta) {
    if (!allowLegacy && Object.values(identityFrom(app)).some(Boolean)) throw new Error("Unmigrated applicant identity.");
    return result as DemoApplicantRow;
  }
  // A protected row must not also retain readable identity in the ordinary form.
  if (FIELDS.some((field) => app && Object.hasOwn(app, field))) throw new Error("Applicant identity has an invalid plaintext copy.");
  let identity: Identity;
  try {
    const opened = JSON.parse(decryptSensitiveValue(meta.ciphertext, context(recordId, meta.originOwnerId)));
    const identityObject = asObject(opened);
    if (!identityObject || FIELDS.some((field) => typeof identityObject[field] !== "string")) throw new Error();
    identity = identityFrom(identityObject);
  } catch {
    throw new Error("Unable to open protected applicant identity.");
  }
  return { ...result, application: { ...app, ...identity } } as DemoApplicantRow;
}

/** Accepts trusted DB snapshots or server-authorized plaintext. Does not trust client metadata. */
export function sealApplicantRow<T>(raw: T, recordId: string, trustedOwnerId: string | null | undefined): T {
  const row = asObject(raw);
  if (!row) throw new Error("Invalid applicant record.");
  const meta = metadata(row);
  const source = meta ? asObject(openApplicantRow(row, recordId, true))! : row;
  const app = asObject(source.application);
  const identity = identityFrom(app);
  if (!meta && !Object.values(identity).some(Boolean)) return { ...source } as T;
  const ownerId = meta?.originOwnerId ?? trustedOwnerId;
  if (!ownerId?.trim()) throw new Error("Applicant encryption owner is unavailable.");
  const answers = { ...app };
  for (const field of FIELDS) delete answers[field];
  return {
    ...source,
    application: answers,
    [META]: { version: 1, originOwnerId: ownerId, ciphertext: encryptSensitiveValue(JSON.stringify(identity), context(recordId, ownerId)) },
  } as T;
}

/** Drop model/client crypto metadata, preserve only omitted identity from a trusted existing row. */
export function prepareApplicantIdentityWrite(incoming: DemoApplicantRow, existing: unknown, existingRecordId: string): DemoApplicantRow {
  const result = { ...incoming } as unknown as Row;
  delete result[META];
  const stored = asObject(existing);
  if (!stored) return result as DemoApplicantRow;
  const current = openApplicantRow(stored, existingRecordId, true);
  const app = { ...(asObject(result.application) ?? {}) };
  for (const field of FIELDS) {
    if (!Object.hasOwn(app, field) && current.application?.[field] !== undefined) app[field] = current.application[field];
  }
  if (Object.keys(app).length) result.application = app;
  return result as DemoApplicantRow;
}
