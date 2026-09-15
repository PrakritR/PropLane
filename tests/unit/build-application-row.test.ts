import { describe, expect, it } from "vitest";
import type { ParsedResidentDocument, ResidentDocumentImportReview } from "@/lib/resident-document-import/types";
import { buildApplicationRow, buildImportedResidentRow } from "@/lib/resident-document-import/build-application-row";

/**
 * Pins the extracted `buildApplicationRow` to its pre-extraction behavior
 * (snapshot of the key fields), and covers its sibling `buildImportedResidentRow`
 * used by the portfolio-import commit path.
 */

describe("buildApplicationRow", () => {
  it("builds a new manually-added application row from parsed lease fields", () => {
    const parse: ParsedResidentDocument = {
      kind: "lease",
      fileName: "lease.pdf",
      extractedCharacterCount: 500,
      fields: [],
      residentMatch: { kind: "new" },
      propertyMatch: null,
      suggestedApplicationBucket: "approved",
      suggestedLeaseBucket: "signed",
      warnings: [],
    };
    const review: ResidentDocumentImportReview = {
      kind: "lease",
      fileName: "lease.pdf",
      dataUrl: "data:application/pdf;base64,AAAA",
      fields: {
        tenantName: "Jane Doe",
        tenantEmail: "jane@test.proplane.local",
        tenantPhone: "+12065551234",
        monthlyRent: "1500",
        monthlyUtilities: "100",
        securityDeposit: "1500",
        moveInFee: "50",
        leaseStart: "2026-01-01",
        leaseEnd: "2026-12-31",
        leaseTerm: "12-Month",
      },
      propertyId: "prop-1",
      roomId: "room-a",
      residentMode: "new",
      sendAccountSetup: false,
      leaseFullyExecuted: true,
    };

    const row = buildApplicationRow({ parse, review, managerUserId: "mgr-1", propertyLabel: "Oak House" });

    expect(row).toMatchObject({
      name: "Jane Doe",
      email: "jane@test.proplane.local",
      property: "Oak House",
      bucket: "approved",
      stage: "Active",
      assignedPropertyId: "prop-1",
      manuallyAdded: true,
      signedMonthlyRent: 1500,
    });
    expect(row.assignedRoomChoice).toContain("room-a");
    expect(row.manualResidentDetails).toMatchObject({
      phone: "+12065551234",
      moveInDate: "2026-01-01",
      moveOutDate: "2026-12-31",
      monthlyUtilities: 100,
      securityDeposit: 1500,
      moveInFee: 50,
      signedLeaseFileName: "lease.pdf",
      signedLeaseDataUrl: "data:application/pdf;base64,AAAA",
      externallySignedLease: true,
    });
    expect(row.application).toMatchObject({
      propertyId: "prop-1",
      fullLegalName: "Jane Doe",
      email: "jane@test.proplane.local",
      phone: "+12065551234",
      leaseStart: "2026-01-01",
      leaseEnd: "2026-12-31",
      managerRentOverride: "1500",
    });
  });

  it("does not attach a lease pdf review that is not fully executed", () => {
    const parse: ParsedResidentDocument = {
      kind: "lease",
      fileName: "lease.pdf",
      extractedCharacterCount: 500,
      fields: [],
      residentMatch: { kind: "new" },
      propertyMatch: null,
      suggestedApplicationBucket: "approved",
      suggestedLeaseBucket: "manager",
      warnings: [],
    };
    const review: ResidentDocumentImportReview = {
      kind: "lease",
      fileName: "lease.pdf",
      dataUrl: "data:application/pdf;base64,AAAA",
      fields: { tenantName: "Jane Doe", tenantEmail: "jane@test.proplane.local" },
      propertyId: "prop-1",
      roomId: "room-a",
      residentMode: "new",
      sendAccountSetup: false,
      leaseFullyExecuted: false,
    };

    const row = buildApplicationRow({ parse, review, managerUserId: "mgr-1", propertyLabel: "Oak House" });
    expect(row.manualResidentDetails?.signedLeaseDataUrl).toBeUndefined();
  });
});

describe("buildImportedResidentRow", () => {
  it("builds an approved, manually-added row for a portfolio-import resident", () => {
    const row = buildImportedResidentRow({
      id: "PROPLANE-AAA111",
      name: "Bob Resident",
      email: "bob@test.proplane.local",
      phone: "+12065559999",
      propertyId: "imp-oak-house-abc123",
      propertyLabel: "Oak House",
      roomId: "room-1",
      leaseStart: "2026-02-01",
      leaseEnd: null,
      rent: 1200,
      deposit: 1200,
      leasePdf: null,
      managerUserId: "mgr-1",
    });

    expect(row.id).toBe("PROPLANE-AAA111");
    expect(row.bucket).toBe("approved");
    expect(row.stage).toBe("Active");
    expect(row.manuallyAdded).toBe(true);
    expect(row.managerUserId).toBe("mgr-1");
    expect(row.assignedPropertyId).toBe("imp-oak-house-abc123");
    expect(row.assignedRoomChoice).toContain("room-1");
    expect(row.signedMonthlyRent).toBe(1200);
    expect(row.manualResidentDetails?.phone).toBe("+12065559999");
    expect(row.manualResidentDetails?.moveInDate).toBe("2026-02-01");
    expect(row.manualResidentDetails?.signedLeaseDataUrl).toBeUndefined();
    expect(row.application?.fullLegalName).toBe("Bob Resident");
  });

  it("attaches a fully-executed signed lease pdf", () => {
    const row = buildImportedResidentRow({
      id: "PROPLANE-BBB222",
      name: "Cara Resident",
      email: "cara@test.proplane.local",
      propertyId: "imp-oak-house-abc123",
      propertyLabel: "Oak House",
      roomId: "room-2",
      leasePdf: { fileName: "signed.pdf", dataUrl: "data:application/pdf;base64,BBBB", fullyExecuted: true },
      managerUserId: "mgr-1",
    });

    expect(row.manualResidentDetails?.signedLeaseFileName).toBe("signed.pdf");
    expect(row.manualResidentDetails?.signedLeaseDataUrl).toBe("data:application/pdf;base64,BBBB");
    expect(row.manualResidentDetails?.externallySignedLease).toBe(true);
  });

  it("does not attach a lease pdf that is not fully executed", () => {
    const row = buildImportedResidentRow({
      id: "PROPLANE-CCC333",
      name: "Dan Resident",
      email: "dan@test.proplane.local",
      propertyId: "imp-oak-house-abc123",
      propertyLabel: "Oak House",
      roomId: "room-3",
      leasePdf: { fileName: "draft.pdf", dataUrl: "data:application/pdf;base64,CCCC", fullyExecuted: false },
      managerUserId: "mgr-1",
    });

    expect(row.manualResidentDetails?.signedLeaseDataUrl).toBeUndefined();
  });

  it("imports a resident with no email — the row still gets created", () => {
    const row = buildImportedResidentRow({
      id: "PROPLANE-DDD444",
      name: "Eve Resident",
      email: "",
      propertyId: "imp-oak-house-abc123",
      propertyLabel: "Oak House",
      roomId: "room-4",
      managerUserId: "mgr-1",
    });

    expect(row.email).toBe("");
    expect(row.bucket).toBe("approved");
  });
});
