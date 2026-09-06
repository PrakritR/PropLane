import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerEncryptionOwner, openCosignerIdentity, sealCosignerIdentity } from "@/lib/security/cosigner-identity";
import { protectCosignerRecord } from "../../../scripts/security/cosigner-backfill";

const source = { signerAppId: "APP-a", ssn: "123-45-6789", dob: "1980-01-02", dlNumber: "ID-123456", fullName: "Synthetic", backgroundCheck: { status: "pending" } } as CosignerSubmission;
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("co-signer protected identity", () => {
  it("protects only identity fields, retains masked SSN policy and strips metadata from decoded responses", () => {
    const stored = sealCosignerIdentity(source, "record-a", "manager-a");
    for (const field of ["ssn", "dob", "dlNumber"] as const) expect(stored[field]).toMatch(/^proplane:v1:test:/);
    expect(JSON.stringify(stored)).not.toContain(source.dob);
    expect(stored.backgroundCheck).toEqual(source.backgroundCheck);
    const opened = openCosignerIdentity(stored, "record-a");
    expect(opened).toMatchObject({ ssn: "***-**-6789", dob: source.dob, dlNumber: source.dlNumber });
    expect(opened).not.toHaveProperty("_identityProtection");
    expect(source.ssn).toBe("123-45-6789");
  });
  it("rejects copying ciphertext between rows, fields or origin owners", () => {
    const stored = sealCosignerIdentity(source, "record-a", "manager-a");
    expect(() => openCosignerIdentity(stored, "record-b")).toThrow();
    expect(() => openCosignerIdentity({ ...stored, dob: stored.dlNumber }, "record-a")).toThrow();
    expect(() => openCosignerIdentity({ ...stored, _identityProtection: { version: 1, originOwnerId: "manager-b" } }, "record-a")).toThrow();
  });
  it("never accepts plaintext inside a protected row or orphaned ciphertext without metadata", () => {
    const stored = sealCosignerIdentity(source, "record-a", "manager-a");
    expect(() => openCosignerIdentity({ ...stored, dob: source.dob }, "record-a")).toThrow();
    const orphan = { ...stored }; delete orphan._identityProtection;
    expect(() => openCosignerIdentity(orphan, "record-a")).toThrow();
  });
  it("uses trusted origin metadata across ownership transfer and ignores forged metadata on fresh input", () => {
    const forged = { ...source, _identityProtection: { version: 1, originOwnerId: "attacker" } };
    const stored = sealCosignerIdentity(forged, "record-a", "manager-a");
    expect(cosignerEncryptionOwner(stored, "new-current-manager")).toBe("manager-a");
    expect(openCosignerIdentity(stored, "record-a").dob).toBe(source.dob);
  });
  it("supports controlled legacy reads then strict fail-closed reads", () => {
    expect(openCosignerIdentity(source, "record-a").dob).toBe(source.dob);
    vi.stubEnv("COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS", "true");
    expect(() => openCosignerIdentity(source, "record-a")).toThrow(/Unmigrated/);
    const migrated = protectCosignerRecord(source, "record-a", "manager-a");
    expect(migrated.plaintextFields).toBe(3);
    expect(openCosignerIdentity(migrated.value, "record-a").dob).toBe(source.dob);
    expect(protectCosignerRecord(migrated.value, "record-a", "manager-a")).toMatchObject({ changed: false, plaintextFields: 0 });
  });
  it("refuses missing keys/owners and authenticates current-key records during backfill", () => {
    expect(() => protectCosignerRecord(source, "record-a", null)).toThrow();
    const stored = sealCosignerIdentity(source, "record-a", "manager-a");
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
    expect(() => sealCosignerIdentity(source, "record-a", "manager-a")).toThrow();
    expect(() => protectCosignerRecord(stored, "record-a", "manager-a")).toThrow();
  });
});
