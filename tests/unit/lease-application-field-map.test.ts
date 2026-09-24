import { describe, expect, it } from "vitest";
import {
  LEASE_APPLICATION_SHARED_FIELD_KEYS,
  applicationFieldsFromLeaseIntake,
  applicationFieldsFromLeaseRow,
  leaseIntakeFromApplication,
  mergeApplicationAutofillIntoLeaseApp,
  mergeLeaseAutofillIntoApplication,
  normalizeLeaseIntakeAnswers,
} from "@/lib/leasing/lease-application-field-map";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { roomChoiceValue } from "@/lib/rental-application/data";

describe("lease-application-field-map", () => {
  it("exposes the allowlisted bidirectional keys", () => {
    expect([...LEASE_APPLICATION_SHARED_FIELD_KEYS]).toEqual([
      "fullLegalName",
      "email",
      "phone",
      "leaseStart",
      "leaseTerm",
      "propertyId",
      "roomChoice1",
    ]);
  });

  it("maps lease intake → application fields", () => {
    const room = roomChoiceValue("prop-1", "room-a");
    const fields = applicationFieldsFromLeaseIntake({
      fullLegalName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "2065550100",
      leaseStart: "2026-10-01",
      termMonths: 12,
      propertyId: "prop-1",
      listingRoomId: "room-a",
      roomChoice: room,
    });
    expect(fields).toEqual({
      fullLegalName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "2065550100",
      leaseStart: "2026-10-01",
      leaseTerm: "12-Month",
      propertyId: "prop-1",
      roomChoice1: room,
    });
  });

  it("maps application → lease intake", () => {
    const room = roomChoiceValue("prop-2", "room-b");
    const intake = leaseIntakeFromApplication({
      fullLegalName: "Grace Hopper",
      email: "grace@example.com",
      phone: "2065550199",
      leaseStart: "2026-11-15",
      leaseTerm: "6-Month",
      propertyId: "prop-2",
      roomChoice1: room,
    });
    expect(intake.fullLegalName).toBe("Grace Hopper");
    expect(intake.email).toBe("grace@example.com");
    expect(intake.phone).toBe("2065550199");
    expect(intake.leaseStart).toBe("2026-11-15");
    expect(intake.leaseTerm).toBe("6-Month");
    expect(intake.termMonths).toBe(6);
    expect(intake.propertyId).toBe("prop-2");
    expect(intake.listingRoomId).toBe("room-b");
    expect(intake.roomChoice).toBe(room);
  });

  it("round-trips through the map without inventing screening fields", () => {
    const room = roomChoiceValue("prop-3", "room-c");
    const intake = {
      fullLegalName: "Alan Turing",
      email: "alan@example.com",
      phone: "2065550111",
      leaseStart: "2027-01-01",
      leaseTerm: "Long-term",
      propertyId: "prop-3",
      roomChoice: room,
      listingRoomId: "room-c",
    };
    const app = applicationFieldsFromLeaseIntake(intake);
    const back = leaseIntakeFromApplication(app);
    expect(back.fullLegalName).toBe(intake.fullLegalName);
    expect(back.email).toBe(intake.email);
    expect(back.phone).toBe(intake.phone);
    expect(back.leaseStart).toBe(intake.leaseStart);
    expect(back.leaseTerm).toBe(intake.leaseTerm);
    expect(back.propertyId).toBe(intake.propertyId);
    expect(back.roomChoice).toBe(room);
    expect(Object.keys(app)).not.toContain("ssn");
    expect(Object.keys(app)).not.toContain("driversLicense");
  });

  it("prefers leaseIntake on a lease row over mirrored application", () => {
    const fields = applicationFieldsFromLeaseRow({
      leaseIntake: {
        fullLegalName: "From Intake",
        email: "intake@example.com",
        leaseStart: "2026-12-01",
        propertyId: "prop-x",
      },
      application: {
        fullLegalName: "From App",
        email: "app@example.com",
        leaseStart: "2026-01-01",
        propertyId: "prop-y",
      },
      residentName: "Row Name",
      residentEmail: "row@example.com",
    });
    expect(fields.fullLegalName).toBe("From Intake");
    expect(fields.email).toBe("intake@example.com");
    expect(fields.leaseStart).toBe("2026-12-01");
    expect(fields.propertyId).toBe("prop-x");
  });

  it("mergeLeaseAutofillIntoApplication does not overwrite filled answers", () => {
    const current = {
      ...createInitialRentalWizardState(),
      fullLegalName: "Already Set",
      email: "",
      propertyId: "prop-1",
    };
    const next = mergeLeaseAutofillIntoApplication(current, {
      fullLegalName: "From Lease",
      email: "lease@example.com",
      phone: "2065550000",
    });
    expect(next.fullLegalName).toBe("Already Set");
    expect(next.email).toBe("lease@example.com");
    expect(next.phone).toBe("2065550000");
  });

  it("mergeApplicationAutofillIntoLeaseApp copies allowlisted keys", () => {
    const merged = mergeApplicationAutofillIntoLeaseApp(
      { fullLegalName: "Old" },
      { fullLegalName: "New", email: "n@example.com", ssn: "123456789" } as never,
    );
    expect(merged.fullLegalName).toBe("New");
    expect(merged.email).toBe("n@example.com");
    expect((merged as { ssn?: string }).ssn).toBeUndefined();
  });

  it("normalizeLeaseIntakeAnswers drops empty objects", () => {
    expect(normalizeLeaseIntakeAnswers({})).toBeNull();
    expect(normalizeLeaseIntakeAnswers(null)).toBeNull();
    expect(normalizeLeaseIntakeAnswers({ fullLegalName: "  Ada  " })?.fullLegalName).toBe("Ada");
  });
});
