import { describe, expect, it } from "vitest";
import { buildExistingResidentWelcomeEmailBody } from "@/lib/existing-resident-welcome-email";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";
import { hasBothLeaseSignatures, normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";

describe("existing resident welcome email", () => {
  it("does not mention application approval", () => {
    const body = buildExistingResidentWelcomeEmailBody({
      residentName: "Jane",
      axisId: "PROPLANE-TEST",
      signupUrl: "https://example.com/setup",
      propertyLabel: "Ballard House",
    });
    expect(body.toLowerCase()).not.toContain("application has been approved");
    expect(body).toContain("pay");
    expect(body).toContain("open Leases to review and sign");
  });
});

describe("manual resident signed lease pdf", () => {
  it("maps manualResidentDetails upload to lease pdf payload", () => {
    const pdf = manualResidentSignedLeasePdf({
      manualResidentDetails: {
        signedLeaseDataUrl: "data:application/pdf;base64,abc",
        signedLeaseFileName: "lease.pdf",
      },
    });
    expect(pdf?.fileName).toBe("lease.pdf");
    expect(pdf?.dataUrl).toContain("base64");
  });
});

describe("externally signed lease row", () => {
  it("counts as fully signed for payments unlock", () => {
    const iso = new Date().toISOString();
    const row = normalizeLeasePipelineRow({
      id: "lease_test",
      residentName: "Jane",
      residentEmail: "jane@example.com",
      unit: "Room 1",
      bucket: "signed",
      externallySignedLease: true,
      managerSignature: { role: "manager", name: "Mgr", signedAtIso: iso },
      residentSignature: { role: "resident", name: "Jane", signedAtIso: iso },
      thread: [],
    });
    expect(hasBothLeaseSignatures(row)).toBe(true);
    expect(row.externallySignedLease).toBe(true);
  });
});
