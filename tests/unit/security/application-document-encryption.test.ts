import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_DOCUMENT_MAGIC,
  APPLICATION_DOCUMENT_OVERHEAD_BYTES,
  encryptApplicationDocumentUpload,
} from "@/lib/security/application-document-format";
import {
  applicationDocumentOriginalPath,
  createApplicationDocumentUploadEncryption,
  decryptApplicationDocumentBytes,
} from "@/lib/security/application-document-crypto.server";
import { MAX_APPLICATION_PHOTO_BYTES } from "@/lib/rental-application/application-photos";

const path = "application/PROPLANE-APP1/income-123-uuid.pdf.penc";
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS", "");
});
afterEach(() => vi.unstubAllEnvs());

async function encrypted(bytes = Buffer.from("%PDF-1.7 synthetic private document")) {
  const encryption = createApplicationDocumentUploadEncryption(path, bytes.length);
  const blob = await encryptApplicationDocumentUpload(new Blob([new Uint8Array(bytes)]), path, encryption);
  return { bytes, ciphertext: Buffer.from(await blob.arrayBuffer()), encryption };
}

describe("direct-upload application document envelopes", () => {
  it("round trips arbitrary binary bytes from WebCrypto to the server without storing the data key", async () => {
    const { bytes, ciphertext, encryption } = await encrypted(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    expect(decryptApplicationDocumentBytes(ciphertext, path).equals(bytes)).toBe(true);
    expect(ciphertext.includes(bytes)).toBe(false);
    expect(ciphertext.toString()).not.toContain(encryption.dataKey);
    expect(applicationDocumentOriginalPath(path)).toBe(path.slice(0, -5));
  });

  it("uses different object data keys and independent nonces", async () => {
    const a = await encrypted();
    const b = await encrypted();
    expect(a.encryption.dataKey).not.toBe(b.encryption.dataKey);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it.each([
    "application/PROPLANE-OTHER/income-123-uuid.pdf.penc",
    "application/PROPLANE-APP1/income-456-other.pdf.penc",
    "application/PROPLANE-APP1/idFront-123-uuid.jpg.penc",
  ])("rejects transplanting an object into %s", async (otherPath) => {
    const { ciphertext } = await encrypted();
    expect(() => decryptApplicationDocumentBytes(ciphertext, otherPath)).toThrow();
  });

  it("rejects altered ciphertext, tag, wrapped key, nonce, header size and version", async () => {
    const { ciphertext } = await encrypted();
    const magicLength = Buffer.byteLength(APPLICATION_DOCUMENT_MAGIC);
    for (const position of [0, magicLength, magicLength + 20, ciphertext.length - 17, ciphertext.length - 1]) {
      const corrupt = Buffer.from(ciphertext);
      corrupt[position] ^= 1;
      expect(() => decryptApplicationDocumentBytes(corrupt, path)).toThrow();
    }
    const headerLength = ciphertext.readUInt32BE(magicLength);
    const header = JSON.parse(ciphertext.subarray(magicLength + 4, magicLength + 4 + headerLength).toString());
    header.iv = Buffer.alloc(12).toString("base64");
    const corrupt = Buffer.from(ciphertext);
    Buffer.from(JSON.stringify(header)).copy(corrupt, magicLength + 4);
    expect(() => decryptApplicationDocumentBytes(corrupt, path)).toThrow();
  });

  it("never falls back to plaintext for protected paths or renamed envelopes", async () => {
    expect(() => decryptApplicationDocumentBytes(Buffer.from("%PDF-plaintext"), path)).toThrow();
    const { ciphertext } = await encrypted();
    expect(() => decryptApplicationDocumentBytes(ciphertext, path.slice(0, -5))).toThrow();
  });

  it("supports old unencrypted paths only during rollout", () => {
    const old = Buffer.from("legacy bytes");
    expect(decryptApplicationDocumentBytes(old, path.slice(0, -5))).toEqual(old);
    vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS", "true");
    expect(() => decryptApplicationDocumentBytes(old, path.slice(0, -5))).toThrow();
  });

  it("rejects truncation and a file differing from its signed plaintext size", async () => {
    const { ciphertext } = await encrypted();
    expect(() => decryptApplicationDocumentBytes(ciphertext.subarray(0, -1), path)).toThrow();
    const encryption = createApplicationDocumentUploadEncryption(path, 3);
    const blob = await encryptApplicationDocumentUpload(new Blob(["four"]), path, encryption);
    expect(() => decryptApplicationDocumentBytes(Buffer.from(new Uint8Array([])), path)).toThrow();
    const invalid = Buffer.from(await blob.arrayBuffer());
    expect(() => decryptApplicationDocumentBytes(invalid, path)).toThrow();
  });

  it("keeps a 15 MB original within the new Storage bucket ceiling", async () => {
    const { bytes, ciphertext } = await encrypted(Buffer.alloc(MAX_APPLICATION_PHOTO_BYTES, 42));
    expect(ciphertext.length).toBeLessThanOrEqual(MAX_APPLICATION_PHOTO_BYTES + APPLICATION_DOCUMENT_OVERHEAD_BYTES);
    expect(decryptApplicationDocumentBytes(ciphertext, path).equals(bytes)).toBe(true);
  });

  it("fails closed when the master key is absent", async () => {
    const { ciphertext } = await encrypted();
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
    expect(() => createApplicationDocumentUploadEncryption(path, 10)).toThrow();
    expect(() => decryptApplicationDocumentBytes(ciphertext, path)).toThrow();
  });
});
