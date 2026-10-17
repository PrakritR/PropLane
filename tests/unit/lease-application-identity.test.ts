import { describe, expect, it } from "vitest";
import {
  LEASE_APPLICATION_IDENTITY_KEYS,
  stripApplicantIdentityFromLeaseApplication,
  stripIdentityFromLeaseRow,
} from "@/lib/lease-application-identity";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";

const IDENTITY = {
  ssn: "123-45-6789",
  dateOfBirth: "1990-02-03",
  driversLicense: "D1234567",
  _applicantIdentity: { v: 1, iv: "x", ct: "y" },
};

describe("stripApplicantIdentityFromLeaseApplication", () => {
  it("removes every identity key and keeps everything else", () => {
    const app = { fullLegalName: "Jordan Lee", email: "j@example.com", leaseStart: "2026-06-01", ...IDENTITY };
    const out = stripApplicantIdentityFromLeaseApplication(app);
    for (const key of LEASE_APPLICATION_IDENTITY_KEYS) expect(out).not.toHaveProperty(key);
    expect(out).toEqual({ fullLegalName: "Jordan Lee", email: "j@example.com", leaseStart: "2026-06-01" });
  });

  it("does not mutate its input", () => {
    const app = { fullLegalName: "A", ...IDENTITY };
    stripApplicantIdentityFromLeaseApplication(app);
    expect(app.ssn).toBe("123-45-6789");
  });

  it("strips a key whose value is empty or null too", () => {
    const out = stripApplicantIdentityFromLeaseApplication({ fullLegalName: "A", ssn: "", dateOfBirth: null });
    expect(out).toEqual({ fullLegalName: "A" });
  });

  it("returns the same object when there is nothing to strip", () => {
    const app = { fullLegalName: "A" };
    expect(stripApplicantIdentityFromLeaseApplication(app)).toBe(app);
  });

  it("passes through non-objects", () => {
    expect(stripApplicantIdentityFromLeaseApplication(undefined)).toBeUndefined();
    expect(stripApplicantIdentityFromLeaseApplication(null)).toBeNull();
    expect(stripApplicantIdentityFromLeaseApplication("x")).toBe("x");
  });
});

describe("stripIdentityFromLeaseRow", () => {
  it("strips row.application and each signedLeaseSnapshots[*].application", () => {
    const row = {
      id: "l1",
      generatedHtml: "<p>executed</p>",
      application: { fullLegalName: "A", ...IDENTITY },
      signedLeaseSnapshots: [
        { id: "s1", application: { email: "e", ssn: "9" } },
        { id: "s2" },
        { id: "s3", application: { dateOfBirth: "x", phone: "p" } },
      ],
    };
    const out = stripIdentityFromLeaseRow(row);
    expect(out.application).toEqual({ fullLegalName: "A" });
    expect(out.signedLeaseSnapshots).toEqual([
      { id: "s1", application: { email: "e" } },
      { id: "s2" },
      { id: "s3", application: { phone: "p" } },
    ]);
    expect(row.application.ssn).toBe("123-45-6789");
  });

  it("never touches the executed document", () => {
    const row = { id: "l1", generatedHtml: "<p>Date of birth: 1990</p>", application: { ssn: "1" } };
    expect(stripIdentityFromLeaseRow(row).generatedHtml).toBe(row.generatedHtml);
  });

  it("returns the same object for a clean row and tolerates junk", () => {
    const clean = { id: "l1", application: { email: "e" }, signedLeaseSnapshots: [{ id: "s" }] };
    expect(stripIdentityFromLeaseRow(clean)).toBe(clean);
    expect(stripIdentityFromLeaseRow(null)).toBeNull();
    expect(stripIdentityFromLeaseRow({ application: "str", signedLeaseSnapshots: "x" })).toEqual({
      application: "str",
      signedLeaseSnapshots: "x",
    });
  });
});

describe("normalizeLeasePipelineRow", () => {
  it("drops applicant identity from a legacy row on every read and write path", () => {
    const row = normalizeLeasePipelineRow({
      id: "lease_1",
      residentName: "Jordan Lee",
      residentEmail: "j@example.com",
      application: { fullLegalName: "Jordan Lee", ...IDENTITY },
    });
    expect(row.application).toEqual({ fullLegalName: "Jordan Lee" });
    expect(JSON.stringify(row)).not.toContain("123-45-6789");
    expect(JSON.stringify(row)).not.toContain("1990-02-03");
    expect(JSON.stringify(row)).not.toContain("D1234567");
  });
});
