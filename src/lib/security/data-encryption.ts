import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "proplane:v1:";
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type EncryptionContext = {
  purpose: string;
  ownerId: string;
  recordId: string;
  field: string;
};

function aad(context: EncryptionContext, keyId: string): Buffer {
  const parts = ["proplane", "v1", keyId, context.purpose, context.ownerId, context.recordId, context.field];
  if (parts.some((part) => typeof part !== "string" || !part.trim())) {
    throw new Error("Encryption context is required.");
  }
  return Buffer.from(JSON.stringify(parts), "utf8");
}

function keyFor(id: string): Buffer {
  if (!KEY_ID.test(id)) throw new Error("Invalid encryption key identifier.");
  let keys: unknown;
  try {
    keys = JSON.parse(process.env.DATA_ENCRYPTION_KEYS_JSON ?? "");
  } catch {
    throw new Error("DATA_ENCRYPTION_KEYS_JSON must contain the configured encryption keys.");
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || !Object.hasOwn(keys, id)) {
    throw new Error("Encryption key is unavailable.");
  }
  const encoded = (keys as Record<string, unknown>)[id];
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error("Encryption keys must be 32 random bytes encoded as base64.");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("Invalid encryption key encoding.");
  }
  return key;
}

/** Key material is supplied by the application secret store, never the database. */
export function encryptSensitiveValue(plaintext: string, context: EncryptionContext): string {
  const keyId = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID ?? "";
  const key = keyFor(keyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(context, keyId));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${keyId}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
}

/** Tampering, missing keys and wrong row/owner/field fail closed. No plaintext fallback. */
export function decryptSensitiveValue(value: string, context: EncryptionContext): string {
  if (!value.startsWith(PREFIX)) throw new Error("Unsupported encrypted value format.");
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 2) throw new Error("Invalid encrypted value.");
  const [keyId, encoded] = parts;
  const payload = Buffer.from(encoded, "base64");
  if (payload.length < 28 || payload.toString("base64") !== encoded) {
    throw new Error("Invalid encrypted value.");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(keyId), payload.subarray(0, 12), { authTagLength: 16 });
    decipher.setAAD(aad(context, keyId));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    // Do not echo provider errors, the ciphertext, keys or sensitive data.
    throw new Error("Unable to decrypt protected data.");
  }
}

export function isEncryptedSensitiveValue(value: string): boolean {
  // Recognize ANY version, so an unknown/corrupted version is never mistaken
  // for a legacy plaintext token by a migration reader.
  return value.startsWith("proplane:");
}
