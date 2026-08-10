/**
 * @vitest-environment jsdom
 *
 * Manager-entered holding fee for one applicant.
 *
 * PropLane stopped auto-collecting a holding deposit at application time in
 * 2026-07 (deposits moved under Payments, after approval), which left managers
 * with no way to ask for a hold at all — `ensurePendingHoldingDepositCharge` is
 * deprecated with no call sites. These functions are the replacement: opt-in,
 * per applicant, with the manager choosing the amount.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  findHoldingDepositCharge,
  markHouseholdChargePaid,
  readHouseholdCharges,
  removeApplicantHoldingFee,
  removeResidentHouseholdPaymentData,
  setApplicantHoldingFee,
} from "@/lib/household-charges";

const EMAIL = "hold.applicant@test.proplane.local";
const PROPERTY = "prop-holding-fee";
const APP_ID = "PROPLANE-HOLD1";

function base(amount: number) {
  return {
    residentEmail: EMAIL,
    residentName: "Hold Applicant",
    residentUserId: null,
    propertyId: PROPERTY,
    applicationId: APP_ID,
    managerUserId: "mgr-1",
    amount,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  removeResidentHouseholdPaymentData(EMAIL);
});

describe("setApplicantHoldingFee", () => {
  it("creates a pending holding_deposit for the manager's amount", () => {
    const result = setApplicantHoldingFee(base(500));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyPaid).toBe(false);
    expect(result.charge.kind).toBe("holding_deposit");
    expect(result.charge.status).toBe("pending");
    expect(result.charge.amountLabel).toBe("$500.00");
    expect(result.charge.applicationId).toBe(APP_ID);
  });

  it("re-prices in place rather than stacking a second hold", () => {
    setApplicantHoldingFee(base(500));
    setApplicantHoldingFee(base(750));
    const holds = readHouseholdCharges().filter(
      (c) => c.kind === "holding_deposit" && c.residentEmail.toLowerCase() === EMAIL,
    );
    expect(holds).toHaveLength(1);
    expect(holds[0]!.amountLabel).toBe("$750.00");
  });

  it("refuses a zero, negative or absurd amount", () => {
    expect(setApplicantHoldingFee(base(0)).ok).toBe(false);
    expect(setApplicantHoldingFee(base(-100)).ok).toBe(false);
    expect(setApplicantHoldingFee(base(1_000_000)).ok).toBe(false);
    expect(readHouseholdCharges().filter((c) => c.kind === "holding_deposit")).toHaveLength(0);
  });

  it("refuses an applicant with no usable email or property", () => {
    expect(setApplicantHoldingFee({ ...base(500), residentEmail: "not-an-email" }).ok).toBe(false);
    expect(setApplicantHoldingFee({ ...base(500), propertyId: "  " }).ok).toBe(false);
  });

  it("never re-prices a hold the applicant already paid", () => {
    const created = setApplicantHoldingFee(base(500));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    markHouseholdChargePaid(created.charge.id);

    const again = setApplicantHoldingFee(base(900));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyPaid).toBe(true);
    // The money already moved — the amount must stand.
    expect(again.charge.amountLabel).toBe("$500.00");
    expect(findHoldingDepositCharge(EMAIL, PROPERTY, null, APP_ID)?.amountLabel).toBe("$500.00");
  });
});

describe("removeApplicantHoldingFee", () => {
  it("removes an unpaid hold", () => {
    setApplicantHoldingFee(base(400));
    const result = removeApplicantHoldingFee({
      residentEmail: EMAIL,
      propertyId: PROPERTY,
      residentUserId: null,
      applicationId: APP_ID,
    });
    expect(result.ok).toBe(true);
    expect(findHoldingDepositCharge(EMAIL, PROPERTY, null, APP_ID)).toBeUndefined();
  });

  it("refuses to delete a PAID hold and says why", () => {
    const created = setApplicantHoldingFee(base(400));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    markHouseholdChargePaid(created.charge.id);

    const result = removeApplicantHoldingFee({
      residentEmail: EMAIL,
      propertyId: PROPERTY,
      residentUserId: null,
      applicationId: APP_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already been paid/i);
    expect(findHoldingDepositCharge(EMAIL, PROPERTY, null, APP_ID)).toBeDefined();
  });

  it("is a no-op when there is no hold", () => {
    expect(
      removeApplicantHoldingFee({
        residentEmail: EMAIL,
        propertyId: PROPERTY,
        residentUserId: null,
        applicationId: APP_ID,
      }).ok,
    ).toBe(true);
  });
});
