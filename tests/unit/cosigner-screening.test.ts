import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  buildCosignerScreeningRow,
  cosignerShowsBackgroundCheck,
} from "@/lib/cosigner-screening";
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

describe("cosigner screening helpers", () => {
  it("cosignerShowsBackgroundCheck requires credit consent", () => {
    expect(cosignerShowsBackgroundCheck(cosigner)).toBe(true);
    expect(cosignerShowsBackgroundCheck({ ...cosigner, consentCredit: false })).toBe(false);
  });

  it("buildCosignerScreeningRow keeps signer application id for API scoping", () => {
    const row = buildCosignerScreeningRow(signerRow, cosigner);
    expect(row.id).toBe("AXIS-TEST");
    expect(row.name).toBe("Co Signer");
    expect(row.application?.fullLegalName).toBe("Co Signer");
    expect(row.application?.consentCredit).toBe(true);
  });
});
