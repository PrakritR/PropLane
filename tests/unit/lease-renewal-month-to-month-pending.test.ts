import { describe, expect, it } from "vitest";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";

/**
 * A month-to-month renewal has no end date by design (`renewLease` stores
 * `leaseEnd: ""`). The row normalizer used to drop any `pendingRenewal` whose
 * `leaseEnd` was empty, so the renewal vanished the first time the row passed
 * through the client: the resident saw no "Renewal ready to sign" and the
 * signed renewal never moved the payment schedule.
 */
function rowWith(pendingRenewal: unknown) {
  return normalizeLeasePipelineRow({
    id: "lease_app_AXIS-X",
    residentName: "Pat",
    residentEmail: "pat@example.test",
    status: "Manager Review",
    pendingRenewal,
  });
}

describe("pendingRenewal survives row normalization", () => {
  it("keeps a month-to-month renewal that has no end date", () => {
    const row = rowWith({
      leaseTerm: "Month-to-Month",
      leaseStart: "2026-11-15",
      leaseEnd: "",
      monthlyRent: 1250,
      rentalType: "standard",
      requestedAtIso: "2026-10-19T00:00:00.000Z",
    });
    expect(row.pendingRenewal).toMatchObject({ leaseTerm: "Month-to-Month", leaseStart: "2026-11-15", leaseEnd: "", monthlyRent: 1250 });
  });

  it("still keeps a fixed-term renewal", () => {
    const row = rowWith({
      leaseTerm: "12 months",
      leaseStart: "2026-11-15",
      leaseEnd: "2027-11-14",
      monthlyRent: 1250,
      requestedAtIso: "2026-10-19T00:00:00.000Z",
    });
    expect(row.pendingRenewal?.leaseEnd).toBe("2027-11-14");
  });

  it("still drops a fixed-term renewal with no end date (malformed)", () => {
    const row = rowWith({ leaseTerm: "12 months", leaseStart: "2026-11-15", leaseEnd: "", monthlyRent: 1250, requestedAtIso: "2026-10-19T00:00:00.000Z" });
    expect(row.pendingRenewal).toBeNull();
  });
});
