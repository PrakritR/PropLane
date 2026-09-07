import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";
import { resolveResidentOnboardingStage } from "@/lib/resident-onboarding/resolve-onboarding-stage";

/**
 * The composition that made "ask, don't assume" real.
 *
 * Clearing `externallySignedLease` is NOT enough on its own.
 * `manualResidentSignedLeasePdf` keys on `signedLeaseDataUrl` ALONE, and
 * `syncLeasePipelineFromApplications` stamps `fullySignedAt`, both signatures
 * and `externallySignedLease: true` onto any row it returns a PDF for. So a
 * draft parked in that field executes itself no matter what the flag beside it
 * says — the flag is read after the field has already decided.
 *
 * These drive the same shape `buildManualResidentRow` produces for each filing.
 */
function rowForFiling(filing: "none" | "draft" | "signed"): DemoApplicantRow {
  const onboarding = resolveResidentOnboardingStage({
    name: "Jane Smith",
    email: "jane@example.com",
    propertyId: "prop-1",
    leaseFiling: filing,
  });
  return {
    id: "PROPLANE-TEST",
    name: "Jane Smith",
    email: "jane@example.com",
    property: "Maple St",
    stage: onboarding.stage,
    bucket: onboarding.bucket,
    detail: "",
    manuallyAdded: true,
    manualResidentDetails: {
      // Mirrors the component: the signed-lease fields are written ONLY for an
      // already-signed filing, never merely because a PDF was attached.
      ...(onboarding.externallySignedLease
        ? {
            signedLeaseFileName: "lease.pdf",
            signedLeaseDataUrl: "data:application/pdf;base64,AAAA",
            signedLeaseUploadedAt: "2026-09-07T00:00:00.000Z",
            externallySignedLease: true as const,
          }
        : {}),
    },
  } as DemoApplicantRow;
}

describe("a lease filed as a DRAFT", () => {
  it("produces no off-platform PDF filing, so the lease sync cannot execute it", () => {
    expect(manualResidentSignedLeasePdf(rowForFiling("draft"))).toBeNull();
  });

  it("leaves externallySignedLease unset, which is what gates the resident's Services stage", () => {
    expect(rowForFiling("draft").manualResidentDetails?.externallySignedLease).toBeUndefined();
  });

  it("still approves the resident — the tenancy is real, only the signatures are missing", () => {
    expect(rowForFiling("draft").bucket).toBe("approved");
  });
});

describe("a lease filed as ALREADY SIGNED", () => {
  it("does produce the off-platform filing the executed path needs", () => {
    const pdf = manualResidentSignedLeasePdf(rowForFiling("signed"));
    expect(pdf).not.toBeNull();
    expect(pdf?.fileName).toBe("lease.pdf");
  });

  it("marks the row executed off-platform", () => {
    expect(rowForFiling("signed").manualResidentDetails?.externallySignedLease).toBe(true);
  });
});

describe("no lease at all", () => {
  it("files nothing and stays unexecuted", () => {
    expect(manualResidentSignedLeasePdf(rowForFiling("none"))).toBeNull();
    expect(rowForFiling("none").manualResidentDetails?.externallySignedLease).toBeUndefined();
  });
});
