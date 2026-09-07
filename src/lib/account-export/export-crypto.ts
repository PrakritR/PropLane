/**
 * The `.proplane` container: one password-protected, authenticated blob.
 *
 * AES-256-GCM with a key derived from the manager's password by scrypt. The manager keeps
 * the password; PropLane never stores it, never logs it, and never sees the file again
 * once the response is sent — so the password really is the only way to open the file,
 * and a wrong password is a GCM authentication failure rather than garbage output.
 *
 * Layout (all lengths in bytes, big-endian where it matters):
 *
 *   0   8   magic         "PLEXPORT"
 *   8   1   version       1
 *   9   1   scrypt log2 N
 *   10  1   scrypt r
 *   11  1   scrypt p
 *   12  16  salt
 *   28  12  iv
 *   40  16  GCM auth tag
 *   56  …   ciphertext
 *
 * Bytes 0..40 are the GCM additional authenticated data, so a tampered KDF parameter or
 * salt fails authentication instead of quietly deriving a different key.
 *
 * `scripts/open-proplane-export.mjs` re-implements this exact layout with nothing but
 * Node's `crypto`, so a manager who has left the product can still open the file. Keep the
 * two in sync — a version bump here is a version branch there.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { validateExportPassword } from "@/lib/account-export/export-password";

export {
  EXPORT_FILE_EXTENSION,
  EXPORT_FILE_MIME,
  EXPORT_PASSWORD_MAX_LENGTH,
  EXPORT_PASSWORD_MIN_LENGTH,
  validateExportPassword,
} from "@/lib/account-export/export-password";

export const EXPORT_FILE_MAGIC = "PLEXPORT";
export const EXPORT_FILE_VERSION = 1;

/** scrypt N = 2^15, r = 8, p = 1: ~32 MiB and well under a second on a serverless CPU. */
const SCRYPT_LOG2_N = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const MAGIC_BYTES = Buffer.from(EXPORT_FILE_MAGIC, "ascii");
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HEADER_LENGTH = MAGIC_BYTES.length + 4 + SALT_LENGTH + IV_LENGTH; // 40
const PREFIX_LENGTH = HEADER_LENGTH + TAG_LENGTH; // 56

export class ExportDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportDecryptError";
  }
}

function deriveKey(password: string, salt: Buffer, log2N: number, r: number, p: number): Buffer {
  return scryptSync(Buffer.from(password.normalize("NFKC"), "utf8"), salt, KEY_LENGTH, {
    N: 2 ** log2N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Seal `plaintext` under `password`. The result is the whole file. */
export function encryptExportPayload(plaintext: Uint8Array, password: string): Buffer {
  const invalid = validateExportPassword(password);
  if (invalid) throw new Error(invalid);

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC_BYTES.copy(header, 0);
  header.writeUInt8(EXPORT_FILE_VERSION, 8);
  header.writeUInt8(SCRYPT_LOG2_N, 9);
  header.writeUInt8(SCRYPT_R, 10);
  header.writeUInt8(SCRYPT_P, 11);
  salt.copy(header, 12);
  iv.copy(header, 28);

  const key = deriveKey(password, salt, SCRYPT_LOG2_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);

  return Buffer.concat([header, tag, ciphertext]);
}

/**
 * Open a file produced by `encryptExportPayload`. Throws `ExportDecryptError` for a file
 * that is not a PropLane export, a version this build does not know, or a wrong password —
 * the last two are indistinguishable by design (GCM refuses both the same way).
 */
export function decryptExportPayload(file: Uint8Array, password: string): Buffer {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (bytes.length < PREFIX_LENGTH) throw new ExportDecryptError("Not a PropLane export file.");
  if (!timingSafeEqual(bytes.subarray(0, MAGIC_BYTES.length), MAGIC_BYTES)) {
    throw new ExportDecryptError("Not a PropLane export file.");
  }
  const version = bytes.readUInt8(8);
  if (version !== EXPORT_FILE_VERSION) {
    throw new ExportDecryptError(`Unsupported export version ${version}.`);
  }
  const log2N = bytes.readUInt8(9);
  const r = bytes.readUInt8(10);
  const p = bytes.readUInt8(11);
  if (log2N < 10 || log2N > 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new ExportDecryptError("Not a PropLane export file.");
  }
  const header = bytes.subarray(0, HEADER_LENGTH);
  const salt = bytes.subarray(12, 12 + SALT_LENGTH);
  const iv = bytes.subarray(28, 28 + IV_LENGTH);
  const tag = bytes.subarray(HEADER_LENGTH, PREFIX_LENGTH);
  const ciphertext = bytes.subarray(PREFIX_LENGTH);

  const key = deriveKey(password, salt, log2N, r, p);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ExportDecryptError("Wrong password, or the file has been altered.");
  } finally {
    key.fill(0);
  }
}
