import { describe, expect, it } from "vitest";
import {
  EXPORT_EXCLUDED_KEY_PATTERNS,
  isExcludedExportKey,
  normalizeExportKey,
  stripExcludedExportKeys,
} from "@/lib/account-export/pii-exclusion";

/**
 * The export hands manager-owned rows back verbatim, so this list is the only thing
 * between an applicant's SSN and a file on a laptop. Every named pattern from the PRP-324
 * spec must drop, in every casing, at every depth of a `row_data` blob — and ordinary
 * columns must survive, or the export is useless.
 */
describe("EXPORT_EXCLUDED_KEY_PATTERNS", () => {
  it("names every pattern the spec requires", () => {
    for (const required of [
      "ssn",
      "dob",
      "date_of_birth",
      "license",
      "card",
      "routing",
      "account_number",
      "encrypted",
      "token",
      "secret",
      "api_key",
      "password",
    ]) {
      expect(EXPORT_EXCLUDED_KEY_PATTERNS).toContain(required);
    }
  });

  it.each([
    // Government identity numbers, in the exact key shapes the codebase writes
    "ssn",
    "applicant_ssn",
    "ssnLast4",
    "dob",
    "dateOfBirth",
    "date_of_birth",
    "birthDate",
    "driversLicense",
    "driver_license_number",
    "dlNumber",
    "idNumber",
    "passportNumber",
    "socialSecurityNumber",
    // Payment instruments
    "cardNumber",
    "card_last4",
    "routingNumber",
    "routing_number",
    "accountNumber",
    "bank_account_number",
    "iban",
    "cvv",
    // Encrypted envelopes and secrets
    "encrypted_payload",
    "ssnEncrypted",
    "ciphertext",
    "identityEnvelope",
    "access_token",
    "refreshToken",
    "token_hash",
    "client_secret",
    "apiKey",
    "api_key",
    "key_hash",
    "password",
    "encrypted_password",
    "privateKey",
  ])("drops %s", (key) => {
    expect(isExcludedExportKey(key)).toBe(true);
  });

  it.each([
    "id",
    "manager_user_id",
    "resident_email",
    "full_name",
    "phone",
    "address_line_1",
    "monthly_rent_cents",
    "status",
    "created_at",
    "row_data",
    "setting",
    "posting_date",
    "being",
    "description",
    "documentSha256",
    "property_id",
    "last_four",
    "gl_account_code",
    "account_type",
    "amount_cents",
  ])("keeps %s", (key) => {
    expect(isExcludedExportKey(key)).toBe(false);
  });

  it("folds camelCase to snake_case before matching", () => {
    expect(normalizeExportKey("dateOfBirth")).toBe("date_of_birth");
    expect(normalizeExportKey("SSNLast4")).toBe("ssn_last4");
    expect(normalizeExportKey("_applicantIdentity")).toBe("_applicant_identity");
  });
});

describe("stripExcludedExportKeys", () => {
  it("removes excluded keys at every depth of a row_data blob and keeps the rest", () => {
    const row = {
      id: "app-1",
      manager_user_id: "mgr-1",
      resident_email: "sam@example.com",
      row_data: {
        application: {
          fullName: "Sam Applicant",
          email: "sam@example.com",
          ssn: "123-45-6789",
          dateOfBirth: "1990-01-01",
          driversLicense: "WDL123",
          employer: { name: "Acme", phone: "555-0100" },
          references: [{ name: "Pat", ssn: "987-65-4321" }],
        },
        _applicantIdentity: { version: 1, originOwnerId: "mgr-1", ciphertext: "proplane:v1:abc" },
        payment: { cardNumber: "4242", last4: "4242", routingNumber: "021000021" },
      },
    };

    const stripped = stripExcludedExportKeys(row);

    expect(stripped).toEqual({
      id: "app-1",
      manager_user_id: "mgr-1",
      resident_email: "sam@example.com",
      row_data: {
        application: {
          fullName: "Sam Applicant",
          email: "sam@example.com",
          employer: { name: "Acme", phone: "555-0100" },
          references: [{ name: "Pat" }],
        },
        _applicantIdentity: { version: 1, originOwnerId: "mgr-1" },
        payment: { last4: "4242" },
      },
    });
    // Nothing that looks like the original identity survives in any serialization.
    const text = JSON.stringify(stripped);
    expect(text).not.toContain("123-45-6789");
    expect(text).not.toContain("1990-01-01");
    expect(text).not.toContain("WDL123");
    expect(text).not.toContain("021000021");
    expect(text).not.toContain("proplane:v1");
  });

  it("drops an encrypted envelope string wherever it sits, even under a harmless key", () => {
    const stripped = stripExcludedExportKeys({
      note: "proplane:v1:opaque-ciphertext",
      list: ["fine", "proplane:v2:also-opaque"],
      plain: "proplane is the product name, not a prefix",
    });
    expect(stripped).toEqual({ list: ["fine", null], plain: "proplane is the product name, not a prefix" });
  });

  it("does not mutate its input and passes primitives through", () => {
    const row = { ssn: "1", keep: { ssn: "2", ok: true } };
    const copy = JSON.parse(JSON.stringify(row));
    stripExcludedExportKeys(row);
    expect(row).toEqual(copy);
    expect(stripExcludedExportKeys(42)).toBe(42);
    expect(stripExcludedExportKeys(null)).toBeNull();
    expect(stripExcludedExportKeys("text")).toBe("text");
  });
});
