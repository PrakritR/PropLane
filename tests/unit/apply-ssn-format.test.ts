import { describe, expect, it } from "vitest";
import { isPlausibleSsn, validateSsn } from "@/app/(rent)/rent/apply/apply-validation";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";

describe("SSN format (client and server share validateSsn)", () => {
  it.each(["000-12-3456", "666-12-3456", "900-12-3456", "987-12-3456", "123-00-4567", "123-45-0000"])(
    "rejects a number the SSA never issues: %s",
    (value) => {
      expect(validateSsn(value).ok).toBe(false);
    },
  );
  it.each(["123-45-6789", "987-65-4321", "111-11-1111", "222222222", "078-05-1120"])("rejects the obvious fake %s", (value) => {
    expect(validateSsn(value).ok).toBe(false);
  });
  it("still demands nine digits", () => {
    expect(validateSsn("123-45-678")).toEqual({ ok: false, message: "Social Security number must be exactly 9 digits." });
  });
  it("accepts a plausible number", () => {
    expect(validateSsn("536-22-4189").ok).toBe(true);
    expect(isPlausibleSsn("536224189")).toBe(true);
  });
  it("the applicant step refuses a fake and accepts a plausible one", () => {
    const base = createInitialRentalWizardState();
    const fake = validateRentalWizardStep(2, { ...base, fullLegalName: "Ada Lovelace", ssn: "123-45-6789" });
    expect(fake.ssn).toBeTruthy();
    const ok = validateRentalWizardStep(2, { ...base, fullLegalName: "Ada Lovelace", ssn: "536-22-4189" });
    expect(ok.ssn).toBeUndefined();
  });
});
