import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  cosignerListSelectionId,
  isCosignerListSelectionId,
  resolveCosignerListSelection,
} from "@/lib/cosigner-list-selection";

const signerRow = { id: "app-1", bucket: "pending" } as DemoApplicantRow;

const cosigner: CosignerSubmission = {
  id: "cos-9",
  signerAppId: "app-1",
  signerFullName: "Jordan",
  fullName: "Taylor Cosigner",
  email: "taylor@example.com",
  phone: "",
  dob: "",
  dlNumber: "",
  ssn: "",
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
  bankruptcy: "",
  criminal: "",
  consentCredit: true,
};

describe("cosigner-list-selection", () => {
  it("builds and resolves a cosigner list selection id", () => {
    const signerKey = "PROPLANE-APP1";
    const id = cosignerListSelectionId("app-1", cosigner, 0);
    expect(isCosignerListSelectionId(id)).toBe(true);
    const map = new Map<string, CosignerSubmission[]>([[signerKey, [cosigner]]]);
    const resolved = resolveCosignerListSelection(id, [signerRow], map);
    expect(resolved?.sub).toBe(cosigner);
    expect(resolved?.index).toBe(0);
    expect(resolved?.signerRow).toBe(signerRow);
  });

  it("falls back to index when submission id is missing", () => {
    const signerKey = "PROPLANE-APP1";
    const sub = { ...cosigner, id: undefined };
    const id = cosignerListSelectionId("app-1", sub, 0);
    const map = new Map<string, CosignerSubmission[]>([[signerKey, [sub]]]);
    const resolved = resolveCosignerListSelection(id, [signerRow], map);
    expect(resolved?.sub).toBe(sub);
  });
});
