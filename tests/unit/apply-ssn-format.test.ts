import { describe, expect, it } from "vitest";
import { isPlausibleSsn, ssnFieldLabel, validateSsn } from "@/app/(rent)/rent/apply/apply-validation";
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
    expect(validateSsn("123-45-678")).toEqual({ ok: false, message: "SSN or ITIN must be exactly 9 digits." });
  });
  it("accepts a plausible number", () => {
    expect(validateSsn("536-22-4189").ok).toBe(true);
    expect(isPlausibleSsn("536224189")).toBe(true);
  });
  it.each(["900-50-1234", "912-65-4321", "950-70-1234", "988-88-1234", "999-90-1234", "923-92-1234", "934-94-1234", "967-99-1234"])(
    "accepts an ITIN (IRS: area 9xx, group 50-65, 70-88, 90-92 or 94-99): %s",
    (value) => {
      expect(validateSsn(value).ok).toBe(true);
    },
  );
  it.each(["900-49-1234", "912-66-1234", "950-69-1234", "988-89-1234", "999-93-1234", "900-00-1234", "950-70-0000", "999-99-9999"])(
    "rejects a 9xx number outside the ITIN groups or with a zero part: %s",
    (value) => {
      expect(validateSsn(value).ok).toBe(false);
    },
  );
  it("labels the catalog SSN field SSN or ITIN and keeps a manager's own label", () => {
    expect(ssnFieldLabel("Social Security number")).toBe("SSN or ITIN");
    expect(ssnFieldLabel(undefined)).toBe("SSN or ITIN");
    expect(ssnFieldLabel("Tax ID")).toBe("Tax ID");
  });
  it("the applicant step refuses a fake and accepts a plausible one", () => {
    const base = createInitialRentalWizardState();
    const fake = validateRentalWizardStep(2, { ...base, fullLegalName: "Ada Lovelace", ssn: "123-45-6789" });
    expect(fake.ssn).toBeTruthy();
    const ok = validateRentalWizardStep(2, { ...base, fullLegalName: "Ada Lovelace", ssn: "536-22-4189" });
    expect(ok.ssn).toBeUndefined();
  });
});
