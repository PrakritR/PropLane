import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { openApplicantRow, prepareApplicantIdentityWrite, sealApplicantRow } from "@/lib/security/applicant-identity";
import { protectApplicantRecord } from "../../../scripts/security/applicant-backfill";

const source = { id: "PROPLANE-TESTA", managerUserId: "manager-a", application: { ssn: "123-45-6789", dateOfBirth: "1980-01-02", driversLicense: "ID-123456", customAnswers: { pet: "cat" }, attachments: [{ path: "private/object" }] } } as unknown as DemoApplicantRow;
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("applicant identity boundary", () => {
  it("removes identity from stored application while preserving unrelated answers and attachment paths", () => {
    const sealed = sealApplicantRow(source, source.id, "manager-a");
    for (const field of ["ssn", "dateOfBirth", "driversLicense"]) expect(sealed.application).not.toHaveProperty(field);
    expect(JSON.stringify(sealed)).not.toContain("123-45-6789");
    expect(JSON.stringify(sealed)).not.toContain("1980-01-02");
    expect(JSON.stringify(sealed)).toContain("private/object");
    expect(openApplicantRow(sealed, source.id)).toEqual(source);
    expect(source.application?.ssn).toBe("123-45-6789");
  });
  it("authenticates row and origin binding and rejects plaintext beside a protected envelope", () => {
    const sealed = sealApplicantRow(source, source.id, "manager-a");
    expect(() => openApplicantRow(sealed, "PROPLANE-OTHER")).toThrow();
    const raw = sealed as unknown as Record<string, unknown>;
    expect(() => openApplicantRow({ ...raw, _applicantIdentity: { ...(raw._applicantIdentity as object), originOwnerId: "manager-b" } }, source.id)).toThrow();
    expect(() => openApplicantRow({ ...sealed, application: { ...sealed.application, ssn: "" } }, source.id)).toThrow();
    expect(() => openApplicantRow(sealed, "testa")).toThrow();
    expect(() => openApplicantRow(sealed, source.id.toLowerCase())).toThrow();
    const canonicalized = prepareApplicantIdentityWrite({ ...source, id: "PROPLANE-NEW" }, sealed, source.id);
    const rekeyed = sealApplicantRow(canonicalized, "PROPLANE-NEW", "manager-a");
    expect(openApplicantRow(rekeyed, "PROPLANE-NEW").application?.ssn).toBe(source.application?.ssn);
    expect(() => openApplicantRow(rekeyed, source.id)).toThrow();
  });
  it("preserves omitted fields through partial form replacement but honors explicit clearing", () => {
    const sealed = sealApplicantRow(source, source.id, "manager-a");
    const incoming = { id: source.id, application: { driversLicense: "", customAnswers: { pet: "dog" } }, _applicantIdentity: { originOwnerId: "attacker" } } as unknown as DemoApplicantRow;
    const prepared = prepareApplicantIdentityWrite(incoming, sealed, source.id);
    expect(prepared).not.toHaveProperty("_applicantIdentity");
    expect(prepared.application).toMatchObject({ ssn: source.application?.ssn, dateOfBirth: source.application?.dateOfBirth, driversLicense: "", customAnswers: { pet: "dog" } });
    const persisted = sealApplicantRow(prepared, source.id, "manager-a");
    expect(JSON.stringify(persisted)).not.toContain("123-45-6789");
    expect(openApplicantRow(persisted, source.id).application?.driversLicense).toBe("");
  });
  it("preserves protection across metadata-only updates and owner transfers", () => {
    const sealed = sealApplicantRow(source, source.id, "manager-a");
    const moved = sealApplicantRow({ ...sealed, managerUserId: "manager-b", stage: "Approved" }, source.id, "manager-b");
    expect((moved as unknown as { _applicantIdentity: { originOwnerId: string } })._applicantIdentity.originOwnerId).toBe("manager-a");
    expect(openApplicantRow(moved, source.id).application?.ssn).toBe(source.application?.ssn);
  });
  it("backfills idempotently, validates tamper, rotates keys and enables strict reads", () => {
    vi.stubEnv("APPLICANT_IDENTITY_REQUIRE_ENCRYPTED_READS", "true");
    expect(() => openApplicantRow(source, source.id)).toThrow(/Unmigrated/);
    const migrated = protectApplicantRecord(source, source.id, "manager-a");
    expect(migrated.plaintextFields).toBe(3);
    expect(openApplicantRow(migrated.value, source.id)).toEqual(source);
    expect(protectApplicantRecord(migrated.value, source.id, "manager-a").changed).toBe(false);
    expect(() => protectApplicantRecord(migrated.value, "PROPLANE-OTHER", "manager-a")).toThrow();
    const keys = JSON.parse(process.env.DATA_ENCRYPTION_KEYS_JSON!);
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ ...keys, next: randomBytes(32).toString("base64") }));
    vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "next");
    const rotated = protectApplicantRecord(migrated.value, source.id, "manager-b");
    expect(rotated.changed).toBe(true);
    expect(openApplicantRow(rotated.value, source.id)).toEqual(source);
  });
  it("fails closed without owner or key; blank metadata-only rows need neither", () => {
    expect(() => sealApplicantRow(source, source.id, null)).toThrow();
    expect(() => protectApplicantRecord(source, source.id, null)).toThrow();
    vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
    expect(() => sealApplicantRow(source, source.id, "manager-a")).toThrow();
    expect(sealApplicantRow({ id: source.id }, source.id, null)).toEqual({ id: source.id });
  });
});
