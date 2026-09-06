import { describe, expect, it } from "vitest";
import {
  validateAxisGroupId,
  validateEmail,
  validateFullName,
  validateHouseholdCount,
  validatePhone10,
  validateSsn,
  validateStateAbbrev,
  validateZip,
} from "@/app/(public)/rent/apply/apply-validation";

describe("apply-validation", () => {
  it("validates full name", () => {
    expect(validateFullName("John Doe").ok).toBe(true);
    expect(validateFullName("John").ok).toBe(false);
  });

  it("validates state abbreviations", () => {
    expect(validateStateAbbrev("WA").ok).toBe(true);
    expect(validateStateAbbrev("XX").ok).toBe(false);
  });

  it("validates SSN and phone", () => {
    expect(validateSsn("123-45-6789").ok).toBe(true);
    expect(validateSsn("123").ok).toBe(false);
    expect(validatePhone10("(206) 555-0142").ok).toBe(true);
    expect(validatePhone10("+12065550142").ok).toBe(true);
    expect(validatePhone10("123").ok).toBe(false);
  });

  it("validates email and zip", () => {
    expect(validateEmail("a@b.co").ok).toBe(true);
    expect(validateEmail("bad").ok).toBe(false);
    expect(validateZip("98105").ok).toBe(true);
    expect(validateZip("981").ok).toBe(false);
  });

  it("validates group id and household count", () => {
    expect(validateAxisGroupId("PROPLANE-abc12345").ok).toBe(true);
    expect(validateAxisGroupId("AXISGRP-abc12345").ok).toBe(true);
    expect(validateAxisGroupId("BAD").ok).toBe(false);
    expect(validateHouseholdCount("3").ok).toBe(true);
    expect(validateHouseholdCount("1").ok).toBe(false);
  });
});
