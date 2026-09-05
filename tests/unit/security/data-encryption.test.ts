import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/security/data-encryption";

const context = { purpose: "oauth", ownerId: "manager-a", recordId: "connection-a", field: "refreshToken" };
let firstKey: string;
beforeEach(() => {
  firstKey = randomBytes(32).toString("base64");
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "key-1");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ "key-1": firstKey }));
});
afterEach(() => vi.unstubAllEnvs());

describe("application encryption", () => {
  it("round trips Unicode with independent nonces and no plaintext in storage", () => {
    const plaintext = "sensitive-token-秘密";
    const a = encryptSensitiveValue(plaintext, context);
    const b = encryptSensitiveValue(plaintext, context);
    expect(a).not.toBe(b);
    expect(a).not.toContain(plaintext);
    expect(decryptSensitiveValue(a, context)).toBe(plaintext);
  });
  it.each(["ownerId", "recordId", "purpose", "field"])("rejects ciphertext moved to another %s", (field) => {
    const value = encryptSensitiveValue("secret", context);
    expect(() => decryptSensitiveValue(value, { ...context, [field]: "other" })).toThrow();
  });
  it("rejects altered ciphertext, tag, and nonce", () => {
    const value = encryptSensitiveValue("secret", context);
    const payload = Buffer.from(value.split(":")[3], "base64");
    for (const index of [0, 12, 28]) {
      const corrupt = Buffer.from(payload);
      corrupt[index] ^= 1;
      expect(() => decryptSensitiveValue(`proplane:v1:key-1:${corrupt.toString("base64")}`, context)).toThrow();
    }
  });
  it("rotates writes while retaining access to older ciphertext", () => {
    const old = encryptSensitiveValue("old secret", context);
    vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "key-2");
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ "key-1": firstKey, "key-2": randomBytes(32).toString("base64") }));
    expect(encryptSensitiveValue("new secret", context)).toMatch(/^proplane:v1:key-2:/);
    expect(decryptSensitiveValue(old, context)).toBe("old secret");
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ "key-2": randomBytes(32).toString("base64") }));
    expect(() => decryptSensitiveValue(old, context)).toThrow();
  });
  it.each(["", "not-json", "null", "[]", '{"key-1":"password"}', '{"key-1":"AAAA"}'])("fails closed with bad key configuration %s", (keys) => {
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", keys);
    expect(() => encryptSensitiveValue("secret", context)).toThrow();
  });
  it.each(["plaintext", "proplane:v2:key-1:AAAA", "proplane:v1:key-1:AAAA", "proplane:v1:key-1:!"])("rejects invalid ciphertext format", (value) => {
    expect(() => decryptSensitiveValue(value, context)).toThrow();
  });
});
