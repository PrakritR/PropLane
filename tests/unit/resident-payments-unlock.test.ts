/**
 * C140: the Payments lock no longer excludes a resident with a signed lease
 * but zero charges — a resident the manager placed directly onto a lease,
 * never through an application, previously stayed locked until their first
 * charge existed.
 */
import { describe, expect, it } from "vitest";
import { residentPaymentsUnlocked } from "@/lib/resident-payments-unlock";
import type { HouseholdCharge } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const charge = (over: Partial<HouseholdCharge> = {}): HouseholdCharge => ({
  id: "hc-1",
  residentEmail: "resident@example.com",
  kind: "rent",
  status: "pending",
  amountCents: 100000,
  dueDate: "2026-07-01",
  ...over,
} as HouseholdCharge);

const signedLease = (): LeasePipelineRow =>
  ({
    id: "lease-1",
    residentSignature: { name: "Jamie Rivera", signedAtIso: "2026-06-01T00:00:00.000Z", role: "resident" },
  }) as unknown as LeasePipelineRow;

describe("residentPaymentsUnlocked", () => {
  it("unlocks on an approved application alone", () => {
    expect(
      residentPaymentsUnlocked({ hasApprovedApplication: true, charges: [], lease: null }),
    ).toBe(true);
  });

  it("unlocks on a tenancy-implying charge alone", () => {
    expect(
      residentPaymentsUnlocked({
        hasApprovedApplication: false,
        charges: [charge({ kind: "rent", status: "pending" })],
        lease: null,
      }),
    ).toBe(true);
  });

  it("does NOT unlock on an application-fee-only charge (a prospect owes those)", () => {
    expect(
      residentPaymentsUnlocked({
        hasApprovedApplication: false,
        charges: [charge({ kind: "application_fee", status: "paid" })],
        lease: null,
      }),
    ).toBe(false);
  });

  it("C140: unlocks a manager-placed resident with a signed lease and zero charges", () => {
    expect(
      residentPaymentsUnlocked({
        hasApprovedApplication: false,
        charges: [],
        lease: signedLease(),
      }),
    ).toBe(true);
  });

  it("stays locked when the lease exists but is NOT yet signed", () => {
    expect(
      residentPaymentsUnlocked({
        hasApprovedApplication: false,
        charges: [],
        lease: { id: "lease-1" } as unknown as LeasePipelineRow,
      }),
    ).toBe(false);
  });

  it("stays locked with no application, no charge, and no lease at all", () => {
    expect(
      residentPaymentsUnlocked({ hasApprovedApplication: false, charges: [], lease: null }),
    ).toBe(false);
  });
});
