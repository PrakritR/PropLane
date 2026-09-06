import "server-only";
import { createDecipheriv, randomBytes } from "node:crypto";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/security/data-encryption";
import {
  APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX,
  APPLICATION_DOCUMENT_MAGIC,
  APPLICATION_DOCUMENT_MAX_HEADER_BYTES,
  APPLICATION_DOCUMENT_OVERHEAD_BYTES,
  applicationDocumentAad,
  type ApplicationDocumentUploadEncryption,
} from "@/lib/security/application-document-format";
import { MAX_APPLICATION_PHOTO_BYTES } from "@/lib/rental-application/application-photos";

function context(storagePath: string) {
  applicationDocumentAad(storagePath);
  // The application folder is immutable. Binding to today's manager would break
  // legitimate property transfers; current actor/manager access is checked by the route.
  return { purpose: "application-document-key", ownerId: storagePath.split("/")[1], recordId: storagePath, field: "data-key" };
}

/** Call only after authorizing the stored application, never an owner ID from the request. */
export function createApplicationDocumentUploadEncryption(
  storagePath: string,
  sizeBytes: number,
): ApplicationDocumentUploadEncryption {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_APPLICATION_PHOTO_BYTES) {
    throw new Error("Invalid document size.");
  }
  const dataKey = randomBytes(32).toString("base64");
  const wrappedKey = encryptSensitiveValue(JSON.stringify({ dataKey, sizeBytes }), context(storagePath));
  return { version: 1, dataKey, wrappedKey };
}

/** Legacy objects remain readable only during the measured migration period. */
export function decryptApplicationDocumentBytes(bytes: Buffer, storagePath: string): Buffer<ArrayBuffer> {
  if (!storagePath.endsWith(APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX)) {
    if (bytes.subarray(0, 13).toString("ascii").startsWith("PROPLANE-DOC:") ||
        process.env.DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS === "true") {
      throw new Error("Unmigrated or invalid application document.");
    }
    return Buffer.from(bytes);
  }
  try {
    const additionalData = applicationDocumentAad(storagePath);
    const magic = Buffer.from(APPLICATION_DOCUMENT_MAGIC);
    if (bytes.length > MAX_APPLICATION_PHOTO_BYTES + APPLICATION_DOCUMENT_OVERHEAD_BYTES ||
        bytes.length < magic.length + 4 + 16 || !bytes.subarray(0, magic.length).equals(magic)) {
      throw new Error("Invalid envelope.");
    }
    const headerLength = bytes.readUInt32BE(magic.length);
    const ciphertextOffset = magic.length + 4 + headerLength;
    if (headerLength < 1 || headerLength > APPLICATION_DOCUMENT_MAX_HEADER_BYTES || ciphertextOffset + 16 >= bytes.length) {
      throw new Error("Invalid envelope.");
    }
    const header = JSON.parse(bytes.subarray(magic.length + 4, ciphertextOffset).toString("utf8")) as Record<string, unknown>;
    if (!header || typeof header.wrappedKey !== "string" || typeof header.iv !== "string" ||
        !/^[A-Za-z0-9+/]{16}$/.test(header.iv)) throw new Error("Invalid envelope.");
    const secret = JSON.parse(decryptSensitiveValue(header.wrappedKey, context(storagePath))) as Record<string, unknown>;
    if (!secret || typeof secret.dataKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(secret.dataKey) ||
        !Number.isSafeInteger(secret.sizeBytes) || Number(secret.sizeBytes) < 1 || Number(secret.sizeBytes) > MAX_APPLICATION_PHOTO_BYTES) {
      throw new Error("Invalid envelope.");
    }
    const key = Buffer.from(secret.dataKey, "base64");
    if (key.toString("base64") !== secret.dataKey || bytes.length - ciphertextOffset - 16 !== secret.sizeBytes) {
      throw new Error("Invalid envelope.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"), { authTagLength: 16 });
    key.fill(0);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(ciphertextOffset, bytes.length - 16)), decipher.final()]);
  } catch {
    // Neither key material, filenames, ciphertext nor document contents in errors/logs.
    throw new Error("Unable to decrypt protected application document.");
  }
}

export function applicationDocumentOriginalPath(storagePath: string): string {
  return storagePath.endsWith(APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX)
    ? storagePath.slice(0, -APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX.length) : storagePath;
}
