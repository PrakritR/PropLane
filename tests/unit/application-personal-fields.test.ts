import { describe, expect, it } from "vitest";
import { enrichApplicationForLease, resolveApplicationPersonalFields } from "@/lib/application-personal-fields";
import type { DemoApplicantRow } from "@/data/demo-portal";

function makeRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "app-1",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    property: "Pioneer House",
    propertyId: "pioneer-12a",
    bucket: "approved",
    detail: "",
    submittedAt: "2026-04-10",
    application: {
      fullLegalName: "",
      email: "",
      phone: "(206) 555-0142",
      dateOfBirth: "1998-03-14",
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      leaseTerm: "12-Month",
    },
    ...overrides,
  } as DemoApplicantRow;
}

describe("application-personal-fields", () => {
  it("falls back to row name and email when nested application fields are blank", () => {
    const row = makeRow();
    const personal = resolveApplicationPersonalFields(row);
    expect(personal.fullLegalName).toBe("Jordan Lee");
    expect(personal.email).toBe("jordan.lee@example.com");
    expect(personal.phone).toBe("(206) 555-0142");
    // Birth date stays on the application row and is never resolved for a lease.
    expect(personal).not.toHaveProperty("dateOfBirth");
  });

  it("prefers nested application values when present", () => {
    const row = makeRow({
      name: "Row Name",
      email: "row@example.com",
      application: {
        fullLegalName: "Legal Name",
        email: "app@example.com",
        phone: "(425) 555-0100",
        dateOfBirth: "1990-01-01",
      },
    });
    const personal = resolveApplicationPersonalFields(row);
    expect(personal.fullLegalName).toBe("Legal Name");
    expect(personal.email).toBe("app@example.com");
  });

  it("preserves amended lease dates on the lease snapshot", () => {
    const row = makeRow();
    const fresh = {
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      leaseTerm: "12-Month",
      phone: "(206) 555-0142",
    };
    const existing = {
      leaseStart: "2026-06-01",
      leaseEnd: "2027-08-31",
      leaseTerm: "Extended",
      phone: "",
    };
    const merged = enrichApplicationForLease(row, fresh, existing);
    expect(merged?.leaseEnd).toBe("2027-08-31");
    expect(merged?.phone).toBe("(206) 555-0142");
  });

  it("never carries applicant identity onto the lease snapshot", () => {
    const row = makeRow({
      application: {
        fullLegalName: "Jordan Lee",
        email: "jordan.lee@example.com",
        dateOfBirth: "1998-03-14",
        ssn: "123-45-6789",
        driversLicense: "D1234567",
        leaseStart: "2026-06-01",
        leaseEnd: "2027-05-31",
        leaseTerm: "12-Month",
      },
    });
    const merged = enrichApplicationForLease(row, row.application, { ...row.application });
    expect(merged).not.toHaveProperty("dateOfBirth");
    expect(merged).not.toHaveProperty("ssn");
    expect(merged).not.toHaveProperty("driversLicense");
    expect(merged?.fullLegalName).toBe("Jordan Lee");
  });
});
