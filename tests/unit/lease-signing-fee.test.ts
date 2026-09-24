import { describe, expect, it } from "vitest";

import {
  leaseSigningFeeAllowsSignature,
  recordLeaseSigningFeePaid,
  residentHasPaidLeaseSigningFee,
} from "@/lib/lease-signing-fee";

describe("lease-signing-fee", () => {
  it("allows signature when fee is free", () => {
    expect(
      leaseSigningFeeAllowsSignature({ feeCents: 0, rowData: {}, userId: "u1" }),
    ).toBe(true);
  });

  it("blocks unsigned payers and unlocks after record", () => {
    expect(
      leaseSigningFeeAllowsSignature({ feeCents: 2500, rowData: {}, userId: "u1" }),
    ).toBe(false);
    const paid = recordLeaseSigningFeePaid({}, "u1");
    expect(residentHasPaidLeaseSigningFee(paid, "u1")).toBe(true);
    expect(leaseSigningFeeAllowsSignature({ feeCents: 2500, rowData: paid, userId: "u1" })).toBe(
      true,
    );
    expect(leaseSigningFeeAllowsSignature({ feeCents: 2500, rowData: paid, userId: "u2" })).toBe(
      false,
    );
  });
});
