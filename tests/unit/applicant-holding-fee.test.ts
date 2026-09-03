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
  holdingDepositCreditCentsForApplication,
  markHouseholdChargePaid,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeApplicantHoldingFee,
  removeResidentHouseholdPaymentData,
  setApplicantHoldingFee,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import { writeManagerApplicationRows } from "@/lib/manager-applications-storage";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";

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

describe("holdingDepositCreditCentsForApplication", () => {
  it("credits pending and paid holding deposits toward security deposit", () => {
    setApplicantHoldingFee(base(500));
    expect(holdingDepositCreditCentsForApplication(APP_ID)).toBe(50_000);

    const created = setApplicantHoldingFee(base(500));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    markHouseholdChargePaid(created.charge.id);
    expect(holdingDepositCreditCentsForApplication(APP_ID)).toBe(50_000);
  });

  it("returns zero when there is no holding deposit", () => {
    expect(holdingDepositCreditCentsForApplication(APP_ID)).toBe(0);
  });
});

function seedApprovedListing(propertyId: string) {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: "room-a",
      name: "Room A",
      monthlyRent: 825,
      securityDeposit: "2000",
      utilitiesEstimate: "0",
      utilitiesPaymentModel: "manager_billed",
    },
  ];
  sub.securityDeposit = "2000";
  sub.moveInFee = "0";
  const property: MockProperty = {
    id: propertyId,
    title: "Hold credit home",
    managerUserId: "mgr-1",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property]);
}

function approvedRow(propertyId: string): DemoApplicantRow {
  const roomChoice = `Room A${LISTING_ROOM_CHOICE_SEP}room-a`;
  return {
    id: APP_ID,
    name: "Hold Applicant",
    email: EMAIL,
    property: "Hold credit home",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: "mgr-1",
    application: {
      propertyId,
      roomChoice1: roomChoice,
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
      leaseTerm: "12 months",
      fullLegalName: "Hold Applicant",
    },
  };
}

describe("holding fee security deposit credit at approval", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    removeResidentHouseholdPaymentData(EMAIL);
  });

  it("reduces security deposit by a pending holding fee", () => {
    const propertyId = "prop-hold-credit";
    seedApprovedListing(propertyId);
    setApplicantHoldingFee(base(500));

    recordApprovedApplicationCharges(approvedRow(propertyId), "mgr-1", true);

    const charges = readHouseholdCharges().filter((c) => c.residentEmail === EMAIL);
    expect(charges.find((c) => c.kind === "holding_deposit")?.amountLabel).toBe("$500.00");
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$1,500.00");
    expect(charges.find((c) => c.kind === "security_deposit")?.title).toMatch(/holding deposit credited/i);
  });

  it("re-syncs security deposit when holding fee changes after approval", () => {
    const propertyId = "prop-hold-resync";
    seedApprovedListing(propertyId);
    const row = approvedRow(propertyId);
    writeManagerApplicationRows([row]);
    recordApprovedApplicationCharges(row, "mgr-1", true);
    expect(
      readHouseholdCharges().find((c) => c.kind === "security_deposit" && c.residentEmail === EMAIL)
        ?.amountLabel,
    ).toBe("$2,000.00");

    setApplicantHoldingFee(base(500));
    expect(
      readHouseholdCharges().find((c) => c.kind === "security_deposit" && c.residentEmail === EMAIL)
        ?.amountLabel,
    ).toBe("$1,500.00");
  });
});
