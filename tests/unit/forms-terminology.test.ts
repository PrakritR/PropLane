import { describe, expect, it } from "vitest";
import {
  applicationTerm,
  DEFAULT_APPLICATION_TERM,
  DEFAULT_LEASE_TERM,
  emptyFormsTerminology,
  leaseTerm,
  normalizeFormsTerminology,
} from "@/lib/rental-application/forms-terminology";

describe("forms-terminology", () => {
  it("defaults to Application/Lease when nothing is renamed", () => {
    const empty = emptyFormsTerminology();
    expect(applicationTerm(empty)).toBe(DEFAULT_APPLICATION_TERM);
    expect(leaseTerm(empty)).toBe(DEFAULT_LEASE_TERM);
    expect(applicationTerm(null)).toBe(DEFAULT_APPLICATION_TERM);
    expect(leaseTerm(undefined)).toBe(DEFAULT_LEASE_TERM);
  });

  it("honors a custom rename", () => {
    const custom = normalizeFormsTerminology({ applicationLabel: "Intake form", leaseLabel: "Licensing agreement" });
    expect(custom).not.toBeNull();
    expect(applicationTerm(custom)).toBe("Intake form");
    expect(leaseTerm(custom)).toBe("Licensing agreement");
  });

  it("normalize trims blank labels back to null (default)", () => {
    const normalized = normalizeFormsTerminology({ applicationLabel: "   ", leaseLabel: "" });
    expect(normalized?.applicationLabel).toBeNull();
    expect(normalized?.leaseLabel).toBeNull();
  });

  it("normalize returns null for a non-object", () => {
    expect(normalizeFormsTerminology(null)).toBeNull();
    expect(normalizeFormsTerminology("nope")).toBeNull();
  });

  it("caps a label's length rather than storing an unbounded string", () => {
    const long = "x".repeat(500);
    const normalized = normalizeFormsTerminology({ applicationLabel: long });
    expect(normalized?.applicationLabel?.length).toBe(60);
  });
});
