import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const raw = process.env.FINANCIALS_TIN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("FINANCIALS_TIN_ENCRYPTION_KEY is required for TIN encryption.");
  }
  return createHash("sha256").update(raw).digest();
}

export function encryptTin(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptTin(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  if (buf.length < 28 || buf.toString("base64") !== ciphertext) {
    throw new Error("Invalid encrypted tax identifier.");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function tinLast4(plain: string): string {
  const digits = plain.replace(/\D/g, "");
  return digits.slice(-4);
}

export function formatTinForDisplay(plain: string, type: "ein" | "ssn"): string {
  const digits = plain.replace(/\D/g, "");
  if (type === "ein" && digits.length >= 9) {
    return `${digits.slice(0, 2)}-${digits.slice(2, 9)}`;
  }
  if (type === "ssn" && digits.length >= 9) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
  }
  return plain;
}
