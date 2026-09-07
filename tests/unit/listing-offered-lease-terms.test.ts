/**
 * The applicant's "Lease term" dropdown offers what the LISTING offers.
 *
 * A listing configured before AXI-143 still stores 3/6/9/12-Month, and the apply
 * wizard echoed those verbatim — so a prospect was offered lengths the manager
 * can no longer pick, while Month-to-Month and Custom were absent entirely.
 * Retired lengths now collapse onto Long-term for every PICKER, while the
 * ACCEPTED set stays wider so nothing already stored stops validating.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
  acceptedLeaseTermsFromStored,
  offeredLeaseTermsFromStored,
} from "@/lib/rental-application/lease-terms";

const LEGACY_LISTING = ["3-Month", "6-Month", "9-Month", "12-Month", LONG_TERM_LEASE_TERM];

describe("offeredLeaseTermsFromStored", () => {
  it("collapses a legacy listing's four fixed lengths onto one Long-term row", () => {
    expect(offeredLeaseTermsFromStored(LEGACY_LISTING)).toEqual([LONG_TERM_LEASE_TERM]);
  });

  it("keeps the terms a listing genuinely offers, in canonical order with Custom last", () => {
    const stored = [CUSTOM_LEASE_TERM, "Month-to-Month", SHORT_TERM_LEASE_TERM, "12-Month"];
    expect(offeredLeaseTermsFromStored(stored)).toEqual([
      LONG_TERM_LEASE_TERM,
      "Month-to-Month",
      SHORT_TERM_LEASE_TERM,
      CUSTOM_LEASE_TERM,
    ]);
  });

  it("never offers a retired length, whatever the listing stored", () => {
    for (const legacy of ["3-Month", "6-Month", "9-Month", "12-Month"]) {
      expect(offeredLeaseTermsFromStored([legacy])).toEqual([LONG_TERM_LEASE_TERM]);
    }
  });

  it("is empty for an empty listing, so each caller keeps its own fallback", () => {
    expect(offeredLeaseTermsFromStored([])).toEqual([]);
    expect(offeredLeaseTermsFromStored(["", "  "])).toEqual([]);
  });
});

describe("acceptedLeaseTermsFromStored", () => {
  // Fixing only one side is worse than the bug: validating against the STORED
  // set alone rejects the "Long-term" the form just offered, and validating
  // against the OFFERED set alone rejects an application that legitimately
  // holds "12-Month".
  it("accepts both the offered answer and the length the listing stored", () => {
    const accepted = acceptedLeaseTermsFromStored(["12-Month"]);
    expect(accepted).toContain(LONG_TERM_LEASE_TERM);
    expect(accepted).toContain("12-Month");
  });

  it("is never narrower than what the listing stored, so no filed application starts failing", () => {
    for (const stored of [LEGACY_LISTING, ["Month-to-Month"], [SHORT_TERM_LEASE_TERM, "9-Month"]]) {
      const accepted = acceptedLeaseTermsFromStored(stored);
      for (const term of stored) expect(accepted).toContain(term);
      for (const term of offeredLeaseTermsFromStored(stored)) expect(accepted).toContain(term);
    }
  });

  it("adds nothing for a listing that carries no retired length", () => {
    const stored = [LONG_TERM_LEASE_TERM, "Month-to-Month"];
    expect(acceptedLeaseTermsFromStored(stored)).toEqual(stored);
  });
});
