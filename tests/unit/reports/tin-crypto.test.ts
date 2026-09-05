import { describe, expect, it } from "vitest";
import { encryptTin, decryptTin, tinLast4 } from "@/lib/reports/tin-crypto";

describe("reports/tin-crypto", () => {
  it("encrypts and decrypts TIN", () => {
    const plain = "12-3456789";
    const cipher = encryptTin(plain);
    expect(cipher).not.toContain("3456789");
    expect(decryptTin(cipher)).toBe(plain);
    expect(tinLast4(plain)).toBe("6789");
  });

  it("throws when FINANCIALS_TIN_ENCRYPTION_KEY is unset", () => {
    const previous = process.env.FINANCIALS_TIN_ENCRYPTION_KEY;
    delete process.env.FINANCIALS_TIN_ENCRYPTION_KEY;
    expect(() => encryptTin("12-3456789")).toThrow(/FINANCIALS_TIN_ENCRYPTION_KEY/);
    process.env.FINANCIALS_TIN_ENCRYPTION_KEY = previous;
  });

  it("rejects shortened authentication tags and noncanonical payloads", () => {
    const value = encryptTin("12-3456789");
    const payload = Buffer.from(value, "base64");
    expect(() => decryptTin(payload.subarray(0, 20).toString("base64"))).toThrow();
    expect(() => decryptTin(value + "!")).toThrow();
    payload[payload.length - 1] ^= 1;
    expect(() => decryptTin(payload.toString("base64"))).toThrow();
  });
});
