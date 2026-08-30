import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  backgroundCheckStatusLabel,
  buildScreeningSubjects,
  cosignerSubmissionIdForSubject,
  queueScreeningSubjectIds,
  resolveScreeningSubjectId,
  screeningRowForSubject,
} from "@/lib/background-check-subjects";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

const signerRow: DemoApplicantRow = {
  id: "AXIS-TEST",
  name: "Primary Applicant",
  email: "primary@test.proplane.local",
  property: "Test House",
  propertyId: "prop-1",
  stage: "Submitted",
  bucket: "approved",
  detail: "Approved",
  application: {
    consentCredit: true,
    fullLegalName: "Primary Applicant",
    email: "primary@test.proplane.local",
    propertyId: "prop-1",
  } as DemoApplicantRow["application"],
};

const cosigner: CosignerSubmission = {
  id: "cosigner-abc",
  signerAppId: "AXIS-TEST",
  signerFullName: "Primary Applicant",
  fullName: "Co Signer",
  email: "cosigner@test.proplane.local",
  phone: "5551234567",
  dob: "1980-01-01",
  dlNumber: "",
  ssn: "***-**-1234",
  address: "",
  city: "",
  state: "",
  zip: "",
  notEmployed: false,
  employerName: "",
  employerAddress: "",
  supervisorName: "",
  supervisorPhone: "",
  jobTitle: "",
  monthlyIncome: "",
  annualIncome: "",
  employmentStart: "",
  otherIncome: "",
  bankruptcy: "never",
  criminal: "no",
  consentCredit: true,
  signature: "Co Signer",
  dateSigned: "2026-08-18",
  submittedAt: "2026-08-18T00:00:00.000Z",
};

describe("background-check subjects", () => {
  it("buildScreeningSubjects includes signer and consented co-signer", () => {
    const subjects = buildScreeningSubjects(signerRow, [cosigner]);
    expect(subjects).toHaveLength(2);
    expect(subjects[0]?.type).toBe("signer");
    expect(subjects[1]?.type).toBe("cosigner");
    expect(subjects[1]?.cosignerSubmissionId).toBe("cosigner-abc");
  });

  it("screeningRowForSubject swaps PII for co-signer while keeping application id", () => {
    const row = screeningRowForSubject(signerRow, [cosigner], "cosigner-abc");
    expect(row.id).toBe("AXIS-TEST");
    expect(row.name).toBe("Co Signer");
  });

  it("resolveScreeningSubjectId falls back to signer", () => {
    const subjects = buildScreeningSubjects(signerRow, [cosigner]);
    expect(resolveScreeningSubjectId(subjects, "missing", signerRow.id)).toBe(signerRow.id);
    expect(resolveScreeningSubjectId(subjects, "cosigner-abc", signerRow.id)).toBe("cosigner-abc");
  });

  it("cosignerSubmissionIdForSubject maps co-signer ids only", () => {
    const subjects = buildScreeningSubjects(signerRow, [cosigner]);
    expect(cosignerSubmissionIdForSubject(subjects, signerRow.id)).toBeUndefined();
    expect(cosignerSubmissionIdForSubject(subjects, "cosigner-abc")).toBe("cosigner-abc");
  });

  it("backgroundCheckStatusLabel covers common states", () => {
    expect(backgroundCheckStatusLabel(undefined)).toBe("Not started");
    expect(backgroundCheckStatusLabel({ status: "pending" } as never)).toBe("Pending");
    expect(backgroundCheckStatusLabel({ status: "complete", result: "clear" } as never)).toBe("Clear");
  });

  it("queueScreeningSubjectIds keeps every unique id so bulk request can continue", () => {
    expect(queueScreeningSubjectIds([])).toBeNull();
    expect(queueScreeningSubjectIds(["AXIS-TEST", "cosigner-abc", "AXIS-TEST", "  "])).toEqual({
      current: "AXIS-TEST",
      remaining: ["cosigner-abc"],
    });
  });
});
