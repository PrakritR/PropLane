/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { leaseSendSchedule, leaseSendTermsFor } from "@/lib/lease-send-terms";
import { leaseTermsDriftFromApplication } from "@/lib/lease-terms-drift";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER = "mgr-terms-schedule";

// A manually added resident: the deposit lives in manualResidentDetails, not on the application,
// so the placement resolver alone reads $0 while the billing snapshot (and the schedule) read $250.
const manual = {
  id: "app-fekadu",
  name: "Fekadu Proof",
  email: "fekadu@example.test",
  bucket: "approved",
  stage: "Approved",
  managerUserId: MANAGER,
  manuallyAdded: true,
  signedMonthlyRent: 1100,
  manualResidentDetails: { securityDeposit: 250, moveInDate: "2026-11-04" },
  application: { leaseStart: "2026-11-04", leaseEnd: "", managerRentOverride: "1100" },
} as unknown as DemoApplicantRow;

describe("Send lease: the terms card and the Payments schedule read the same figures", () => {
  it("the deposit on the terms card is the one the schedule bills", () => {
    const schedule = leaseSendSchedule(manual, MANAGER);
    const scheduleDeposit = schedule.find((r) => r.key === "deposit")?.amount;
    expect(scheduleDeposit).toBe(250);
    expect(buildLeaseBillingSnapshot(manual, MANAGER).securityDeposit).toBe(250);
    expect(leaseSendTermsFor(manual).deposit).toBe("0"); // the placement alone is what the card used to show
    expect(leaseSendTermsFor(manual, MANAGER)).toMatchObject({ deposit: "250", rent: "1100", start: "2026-11-04" });
  });

  it("the server-side drift check compares the stored inputs, so a correct send is not refused", () => {
    // Neither the application nor the lease carries a deposit override: equal, no 409.
    expect(leaseTermsDriftFromApplication(manual.application, manual.application)).toEqual([]);
  });
});
