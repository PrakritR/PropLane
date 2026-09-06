import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { encryptSensitiveValue, decryptSensitiveValue } from "../../src/lib/security/data-encryption";
import { PRODUCTION_PROJECT } from "./production-database.mjs";

export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_ROWS_PER_TABLE = 10000;
export const MAX_DOCUMENT_OBJECTS = 1000;
export const SNAPSHOT_TABLES = ["manager_application_records", "cosigner_submission_records", "manager_automation_settings", "application_document_storage_aliases"] as const;
export type BackfillKind = "applicant" | "cosigner" | "calendar" | "document";
export type Snapshot = {
  project: typeof PRODUCTION_PROJECT;
  kind: BackfillKind;
  createdAt: string;
  rows: Record<string, Record<string, unknown>[]>;
  objects: { applicationId: string; path: string; sha256: string; bytes: string; contentType: string }[];
};

export function boundedSnapshotJson(snapshot: Snapshot): string {
  const value = JSON.stringify(snapshot);
  if (Buffer.byteLength(value) > MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds the fixed byte limit.");
  return value;
}

function context(id: string) {
  return { purpose: "production-security-backup", ownerId: PRODUCTION_PROJECT, recordId: id, field: "snapshot" };
}

/** Verification returns data only to the caller; CLI output must remain aggregate-only. */
export function decryptProductionSnapshot(archive: string): Snapshot {
  if (Buffer.byteLength(archive) > MAX_SNAPSHOT_BYTES * 2) throw new Error("Oversized backup archive.");
  const envelope = JSON.parse(archive);
  if (envelope.version !== 1 || envelope.project !== PRODUCTION_PROJECT ||
      typeof envelope.id !== "string" || !/^[a-f0-9-]{36}$/.test(envelope.id) || typeof envelope.ciphertext !== "string") {
    throw new Error("Unsupported backup archive.");
  }
  const plaintext = decryptSensitiveValue(envelope.ciphertext, context(envelope.id));
  if (Buffer.byteLength(plaintext) > MAX_SNAPSHOT_BYTES) throw new Error("Oversized backup content.");
  const snapshot = JSON.parse(plaintext) as Snapshot;
  if (snapshot.project !== PRODUCTION_PROJECT) throw new Error("Backup project mismatch.");
  return snapshot;
}

/** Write encrypted bytes only, exclusively; fsync then authenticate the persisted file. */
export function writeProductionSnapshot(directory: string, snapshot: Snapshot) {
  if (!isAbsolute(directory)) throw new Error("An absolute private backup directory is required.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Backup directory must be owned by the operator and mode 0700.");
  }
  const plaintext = boundedSnapshotJson(snapshot);
  const id = randomUUID();
  const archive = JSON.stringify({ version: 1, project: PRODUCTION_PROJECT, id,
    ciphertext: encryptSensitiveValue(plaintext, context(id)) });
  const path = join(directory, `production-${snapshot.kind}-${id}.json.enc`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, archive); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  const persisted = readFileSync(path, "utf8");
  if (JSON.stringify(decryptProductionSnapshot(persisted)) !== plaintext) throw new Error("Persisted backup verification failed.");
  return { path, sha256: createHash("sha256").update(persisted).digest("hex"), verified: true };
}
