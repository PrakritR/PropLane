import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, leaseTermsPatchForTypes, resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { applicantTermOptions } from "@/lib/rental-application/applicant-lease-term";

function sub(allowedLeaseTerms: string[], extra: Record<string, unknown> = {}) {
  return { ...createDefaultListingSubmission(), allowedLeaseTerms, ...extra };
}

describe("leaseTermsPatchForTypes (the Lease terms picker)", () => {
  it("unticking Short-term removes it from what the applicant is offered", () => {
    const before = sub(["Long-term", "Short-Term Stay"], { shortTermRentalsAllowed: true });
    expect(applicantTermOptions(resolveAllowedLeaseTerms(before)).map((o) => o.value)).toContain("short_term");
    const patch = leaseTermsPatchForTypes(before, ["long_term"]);
    const after = { ...before, ...patch };
    expect(patch.shortTermRentalsAllowed).toBe(false);
    expect(patch.allowedLeaseTerms).toEqual(["Long-term"]);
    expect(applicantTermOptions(resolveAllowedLeaseTerms(after)).map((o) => o.value)).toEqual(["long_term"]);
  });

  it("ticks add the stored term for each type, in canonical order", () => {
    const patch = leaseTermsPatchForTypes(sub(["Long-term"]), ["long_term", "month_to_month", "custom", "short_term"]);
    expect(patch.allowedLeaseTerms).toEqual(["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"]);
    expect(patch.shortTermRentalsAllowed).toBe(true);
    expect(patch.leaseTermsBody).toContain("Month-to-Month");
  });

  it("a retired fixed length stays while Long-term stays ticked, and goes with it", () => {
    const legacy = sub(["12-Month"]);
    expect(leaseTermsPatchForTypes(legacy, ["long_term", "custom"]).allowedLeaseTerms).toEqual(["12-Month", "Custom"]);
    expect(leaseTermsPatchForTypes(legacy, ["custom"]).allowedLeaseTerms).toEqual(["Custom"]);
  });
});
