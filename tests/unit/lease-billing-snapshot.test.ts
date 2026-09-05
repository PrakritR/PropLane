/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import { applyLeaseBillingToContext, buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import {
  applyHouseholdChargePatches,
  readHouseholdCharges,
  seedDemoHouseholdCharges,
  setApplicantHoldingFee,
  markHouseholdChargePaid,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";

import * as applicationStorage from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-lease-billing-snapshot";

function seedListing(propertyId: string, submission: ManagerListingSubmissionV1): void {
  const property: MockProperty = {
    id: propertyId,
    title: "Proration House",
    managerUserId: MANAGER_ID,
    listingSubmission: submission,
  };
  cachePublicExtraListings([property]);
}

function applicantRow(propertyId: string, email: string): DemoApplicantRow {
  const roomId = "room-1";
  const roomChoice = `Room 1${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    id: `app-${email}`,
    name: "Sohan Naik",
    email,
    property: "Proration House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: roomChoice,
      leaseStart: "2026-09-22",
      leaseEnd: "2026-12-01",
      leaseTerm: "Custom",
      rentalType: "standard",
      fullLegalName: "Sohan Naik",
      managerRentOverride: "$800",
      managerUtilitiesOverride: "$200",
    },
  } as unknown as DemoApplicantRow;
}

describe("buildLeaseBillingSnapshot", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it.each([100, 175, 400])("keeps a $400 obligation and credits a paid $%s holding deposit exactly once", (amount) => {
    const propertyId = `prop-paid-holding-${amount}`;
    const email = `paid-holding-${amount}@example.com`;
    removeResidentHouseholdPaymentData(email);
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    });
    seedListing(propertyId, sub);
    const row = applicantRow(propertyId, email);
    const holding = setApplicantHoldingFee({ residentEmail: email, residentName: row.name, residentUserId: null, propertyId, applicationId: row.id, managerUserId: MANAGER_ID, amount });
    expect(holding.ok).toBe(true);
    if (!holding.ok) return;
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const pending = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(pending.securityDeposit).toBe(400);
    expect(pending.securityDepositDue).toBe(400 - amount);
    expect(pending.dueAtSigning).toBe(550);
    expect(pending.holdingDeposit).toEqual({ amount, amountDue: amount, received: 0 });
    markHouseholdChargePaid(holding.charge.id);
    const paid = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(paid.securityDeposit).toBe(400);
    expect(paid.securityDepositDue).toBe(400 - amount);
    expect(paid.holdingDeposit).toEqual({ amount, amountDue: 0, received: amount });
    expect(paid.dueAtSigning).toBe(550 - amount);
  });

  it("does not collect paid deposit and move-in charges again or import another application's holding deposit", () => {
    const propertyId = "prop-paid-deposit";
    const email = "paid-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    for (const charge of readHouseholdCharges().filter((c) => c.applicationId === row.id && ["security_deposit", "move_in_fee"].includes(c.kind))) {
      markHouseholdChargePaid(charge.id);
    }
    setApplicantHoldingFee({ residentEmail: email, residentName: row.name, residentUserId: null, propertyId, applicationId: "another-application", managerUserId: MANAGER_ID, amount: 100 });
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.securityDeposit).toBe(400);
    expect(billing.moveInFee).toBe(150);
    expect(billing.securityDepositDue).toBe(0);
    expect(billing.moveInFeeDue).toBe(0);
    expect(billing.holdingDeposit).toBeUndefined();
    expect(billing.dueAtSigning).toBe(0);
    const html = buildLeaseHtml({
      application: row.application!,
      submission: normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150" }),
      leaseBilling: billing,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
    }, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Already received toward the security deposit and move-in fee: <strong>$550.00</strong>");
    expect(html).toContain("No additional payment is due at signing");
    expect(html).not.toContain("Holding deposit");
  });

  it("keeps a clearing or part-paid balance owed instead of re-quoting the full obligation", () => {
    const propertyId = "prop-clearing-balance";
    const email = "clearing-balance@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    const holding = setApplicantHoldingFee({ residentEmail: email, residentName: row.name, residentUserId: null, propertyId, applicationId: row.id, managerUserId: MANAGER_ID, amount: 100 });
    expect(holding.ok).toBe(true);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const charges = readHouseholdCharges().filter((c) => c.applicationId === row.id);
    const deposit = charges.find((c) => c.kind === "security_deposit")!;
    const moveIn = charges.find((c) => c.kind === "move_in_fee")!;
    applyHouseholdChargePatches([
      { ...readHouseholdCharges().find((c) => c.kind === "holding_deposit" && c.applicationId === row.id)!, status: "processing" },
      { ...deposit, status: "processing" },
      { ...moveIn, status: "partially_paid", balanceLabel: "$50.00", paidAmountCents: 10_000 },
    ]);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.holdingDeposit).toEqual({ amount: 100, amountDue: 100, received: 0 });
    expect(billing.securityDepositDue).toBe(300);
    expect(billing.moveInFeeDue).toBe(50);
    expect(billing.dueAtSigning).toBe(450);
  });

  it("treats a cancelled or refunded charge as settled without calling it a received payment", () => {
    for (const status of ["cancelled", "refunded"] as const) {
      const propertyId = `prop-${status}-deposit`;
      const email = `${status}-deposit@example.com`;
      removeResidentHouseholdPaymentData(email);
      seedListing(propertyId, normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
        rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
      }));
      const row = applicantRow(propertyId, email);
      recordApprovedApplicationCharges(row, MANAGER_ID, true);
      const deposit = readHouseholdCharges().find((c) => c.applicationId === row.id && c.kind === "security_deposit")!;
      applyHouseholdChargePatches([{ ...deposit, status }]);
      const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
      expect(billing.securityDeposit).toBe(400);
      expect(billing.securityDepositDue).toBe(0);
      expect(billing.securityDepositReceived).toBe(0);
      expect(billing.dueAtSigning).toBe(150);
      const html = buildLeaseHtml({
        application: row.application!,
        submission: normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150" }),
        leaseBilling: billing,
        generatedAtIso: "2026-09-01T00:00:00.000Z",
      }, SEATTLE_LEASE_CONFIG);
      expect(html).not.toContain("Already received");
      expect(html).toContain("Security deposit: <strong>$400.00</strong> — no payment due");
    }
  });

  it("reports only cleared dollars as received, never a clearing or part-paid balance", () => {
    const propertyId = "prop-received-clearing";
    const email = "received-clearing@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const charges = readHouseholdCharges().filter((c) => c.applicationId === row.id);
    const deposit = charges.find((c) => c.kind === "security_deposit")!;
    const moveIn = charges.find((c) => c.kind === "move_in_fee")!;
    applyHouseholdChargePatches([
      { ...deposit, status: "processing" },
      { ...moveIn, status: "partially_paid", balanceLabel: "$50.00", paidAmountCents: 10_000 },
    ]);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.securityDepositReceived).toBe(0);
    expect(billing.moveInFeeReceived).toBe(100);
    expect(billing.securityDepositDue).toBe(400);
    expect(billing.moveInFeeDue).toBe(50);
    expect(billing.dueAtSigning).toBe(450);
  });

  it.each(["cancelled", "refunded"] as const)("does not let a %s holding charge disclose or credit a deposit", (status) => {
    for (const withSecurityRow of [true, false]) {
      const propertyId = `prop-void-holding-${status}-${withSecurityRow}`;
      const email = `void-holding-${status}-${withSecurityRow}@example.com`;
      removeResidentHouseholdPaymentData(email);
      seedListing(propertyId, normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
        rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
      }));
      const row = applicantRow(propertyId, email);
      setApplicantHoldingFee({ residentEmail: email, residentName: row.name, residentUserId: null, propertyId, applicationId: row.id, managerUserId: MANAGER_ID, amount: 100 });
      recordApprovedApplicationCharges(row, MANAGER_ID, true);
      const holding = readHouseholdCharges().find((c) => c.applicationId === row.id && c.kind === "holding_deposit")!;
      const patches = [{ ...holding, status }];
      const security = readHouseholdCharges().find((c) => c.applicationId === row.id && c.kind === "security_deposit");
      if (!withSecurityRow && security) applyHouseholdChargePatches([{ ...security, status: "cancelled" as const }]);
      applyHouseholdChargePatches(patches);
      const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
      expect(billing.holdingDeposit).toBeUndefined();
      expect(billing.securityDeposit).toBe(400);
      // A real net security charge keeps its exact balance; a waived one owes nothing.
      expect(billing.securityDepositDue).toBe(withSecurityRow ? 300 : 0);
      expect(billing.securityDepositReceived).toBe(0);
      const html = buildLeaseHtml({
        application: row.application!,
        submission: normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150" }),
        leaseBilling: billing,
        generatedAtIso: "2026-09-01T00:00:00.000Z",
      }, SEATTLE_LEASE_CONFIG);
      expect(html).not.toContain("Holding deposit");
      expect(html).not.toContain("Already received");
    }
  });

  it("reads a cleared holding beside a waived security balance as settled, not paid in full", () => {
    const propertyId = "prop-mixed-deposit-settlement";
    const email = "mixed-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    const holding = setApplicantHoldingFee({ residentEmail: email, residentName: row.name, residentUserId: null, propertyId, applicationId: row.id, managerUserId: MANAGER_ID, amount: 100 });
    expect(holding.ok).toBe(true);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    if (holding.ok) markHouseholdChargePaid(holding.charge.id);
    const security = readHouseholdCharges().find((c) => c.applicationId === row.id && c.kind === "security_deposit")!;
    applyHouseholdChargePatches([{ ...security, status: "cancelled" }]);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.holdingDeposit).toEqual({ amount: 100, amountDue: 0, received: 100 });
    expect(billing.securityDepositDue).toBe(0);
    expect(billing.securityDepositReceived).toBe(100);
    const html = buildLeaseHtml({
      application: row.application!,
      submission: normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150" }),
      leaseBilling: billing,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
    }, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Security deposit: <strong>$400.00</strong> — no payment due");
    expect(html).not.toContain("Security deposit: <strong>$400.00</strong> — paid");
    expect(html).toContain("Holding deposit:</strong> $100.00 (paid)");
    expect(html).toContain("Already received toward the security deposit and move-in fee: <strong>$100.00</strong>");
  });

  it("reads a zero-balance one-time custom fee without receipts as no payment due", () => {
    const propertyId = "prop-waived-custom-fee";
    const email = "waived-custom-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      customFees: [{ id: "one-time", label: "Key replacement", amount: "100", frequency: "one-time" }],
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const fee = readHouseholdCharges().find((c) => c.applicationId === row.id && c.customFeeId === "one-time")!;
    applyHouseholdChargePatches([{ ...fee, status: "cancelled" }]);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.oneTimeCustomFeeBalances?.["one-time"]).toBe(0);
    expect(billing.oneTimeCustomFeeReceived?.["one-time"]).toBe(0);
    const html = buildLeaseHtml({
      application: row.application!,
      submission: normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
        customFees: [{ id: "one-time", label: "Key replacement", amount: "100", frequency: "one-time" }],
      }),
      leaseBilling: billing,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
    }, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Key replacement: <strong>$100.00</strong> — no payment due");
    expect(html).not.toContain("Key replacement: <strong>$100.00</strong> — paid");
  });

  it("keeps an ad-hoc manager charge out of the signing itemization and total", () => {
    const propertyId = "prop-adhoc-fine";
    const email = "adhoc-fine@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    }));
    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const baseline = buildLeaseBillingSnapshot(row, MANAGER_ID);
    // Same shape `createManagerCharge` writes for a fine or a replacement key.
    seedDemoHouseholdCharges([...readHouseholdCharges(), {
      id: `hc_mgr_${Date.now()}_adhoc`,
      createdAt: new Date().toISOString(),
      applicationId: row.id,
      residentEmail: email,
      residentName: row.name,
      residentUserId: null,
      propertyId,
      propertyLabel: "Proration House",
      managerUserId: MANAGER_ID,
      kind: "other_cost",
      title: "Broken window",
      amountLabel: "$75.00",
      balanceLabel: "$75.00",
      status: "pending",
      blocksLeaseUntilPaid: false,
    }]);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.otherCostDue).toBe(baseline.otherCostDue);
    expect(billing.otherCostAmount).toBe(baseline.otherCostAmount);
    expect(billing.dueAtSigning).toBe(baseline.dueAtSigning);
  });

  it("includes an applicable one-time fee in the signing total without making it monthly", () => {
    const propertyId = "prop-one-time-fee";
    const email = "one-time-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "400", moveInFee: "150",
      customFees: [{ id: "one-time", label: "Short-Term Lease Fee", amount: "100", frequency: "one-time" }],
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 800 }],
    });
    seedListing(propertyId, sub);
    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    expect(buildLeaseBillingSnapshot(row, MANAGER_ID).dueAtSigning).toBe(650);
  });

  it("keeps a short stay on its nightly rate and short-term fees through snapshot generation", () => {
    const propertyId = "prop-short-snapshot";
    const email = "short-snapshot@example.com";
    removeResidentHouseholdPaymentData(email);
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), shortTermRentalsAllowed: true,
      shortTermDailyCost: "50", shortTermDeposit: "300", shortTermMoveInFee: "25",
      securityDeposit: "900", moveInFee: "150", paymentAtSigningIncludes: ["security_deposit"],
      rooms: [{ ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 825, shortTermRent: "60", shortTermDeposit: "200", shortTermMoveInFee: "15" }],
    });
    seedListing(propertyId, sub);
    const row = applicantRow(propertyId, email);
    row.application = { ...row.application!, rentalType: "short_term", leaseTerm: "Short-Term Stay", leaseStart: "2026-09-02", leaseEnd: "2026-09-06", managerRentOverride: "", managerUtilitiesOverride: "" };
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.nightlyRent).toBe(60);
    expect(billing.stayRent).toBe(240);
    expect(billing.securityDeposit).toBe(200);
    expect(billing.moveInFee).toBe(15);
    expect(billing.monthlyUtilities).toBe(0);
    expect(billing.dueAtSigning).toBe(200);
    expect(billing.totalBeforeCheckIn).toBe(455);
    const deposit = readHouseholdCharges().find((c) => c.applicationId === row.id && c.kind === "security_deposit");
    expect(deposit).toBeDefined();
    markHouseholdChargePaid(deposit!.id);
    const paid = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(paid.dueAtSigning).toBe(0);
    expect(paid.totalBeforeCheckIn).toBe(255);
  });

  it("prorates the first month with daily rates from the room listing", () => {
    const propertyId = "prop-proration-daily";
    const email = "daily-prorate@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "daily_rate",
        dailyRentRate: 30,
        dailyUtilitiesRate: 7,
      },
    ];
    sub.securityDeposit = "400";
    sub.moveInFee = "150";
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(270);
    expect(billing.proratedUtilities).toBe(63);

    const rentCharge = readHouseholdCharges().find(
      (c) => c.residentEmail === email && c.kind === "prorated_rent",
    );
    expect(rentCharge?.amountLabel).toBe("$270.00");
  });

  it("uses auto proration when the room is on divide/auto", () => {
    const propertyId = "prop-proration-auto";
    const email = "auto-prorate@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "auto",
      },
    ];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(240);
    expect(billing.proratedUtilities).toBe(60);
  });

  it("does not treat last-month proration as the first-month figure", () => {
    const propertyId = "prop-proration-last-month";
    const email = "last-month@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "auto",
      },
    ];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(240);
    expect(billing.proratedUtilities).toBe(60);
    expect(readHouseholdCharges().some((c) => c.residentEmail === email && c.kind === "prorated_last_month_rent")).toBe(
      true,
    );
  });

  it("honors payment-at-signing checkboxes instead of summing every pending charge", () => {
    const propertyId = "prop-signing-includes";
    const email = "signing-includes@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "auto",
      },
    ];
    sub.securityDeposit = "400";
    sub.moveInFee = "100";
    sub.holdingDeposit = "$100";
    sub.applicationFee = "50";
    sub.paymentAtSigningIncludes = ["security_deposit", "move_in_fee"];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.dueAtSigning).toBe(500);
    expect(billing.proratedRent).toBe(240);
  });
  it("uses the signed nightly rate stored on the resident row", () => {
    const propertyId = "signed-nightly-snapshot";
    const row = applicantRow(propertyId, "signed-nightly@example.com");
    row.signedMonthlyRent = 75;
    row.application = { ...row.application!, rentalType: "short_term", leaseStart: "2026-09-02", leaseEnd: "2026-09-06", managerRentOverride: "" };
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), shortTermDailyCost: "50", paymentAtSigningIncludes: ["first_month_rent"],
      rooms: [{ ...emptyRoom(0), id: "room-1", monthlyRent: 825, shortTermRent: "60" }],
    }));
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.nightlyRent).toBe(75);
    expect(billing.stayRent).toBe(300);
    expect(billing.dueAtSigning).toBe(300);
  });

  it.each([false, true])("preserves daily-basis rent through context patching (short stays offered: %s)", (shortTermRentalsAllowed) => {
    const propertyId = `daily-basis-snapshot-${shortTermRentalsAllowed}`;
    const row = applicantRow(propertyId, `daily-basis-${shortTermRentalsAllowed}@example.com`);
    row.application = { ...row.application!, leaseStart: "2026-09-02", leaseEnd: "2026-09-06", managerRentOverride: "", managerUtilitiesOverride: "0" };
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), shortTermRentalsAllowed, paymentAtSigningIncludes: ["first_month_rent"],
      rooms: [{ ...emptyRoom(0), id: "room-1", monthlyRent: 825, rentBasis: "daily", dailyRentPrice: 60 }],
    });
    seedListing(propertyId, sub);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.dailyRent).toBe(60);
    expect(billing.proratedRent).toBe(300); // Standard tenancy includes the final day.
    expect(billing.totalBeforeCheckIn).toBe(shortTermRentalsAllowed ? 300 : undefined);
    expect(billing.dueAtSigning).toBe(300);
    const spy = vi.spyOn(applicationStorage, "readManagerApplicationRows").mockReturnValue([row]);
    try {
      const ctx = applyLeaseBillingToContext({ application: row.application!, submission: sub, generatedAtIso: "2026-09-01T00:00:00.000Z" }, { axisId: row.id, residentEmail: row.email! }, MANAGER_ID);
      expect(ctx.application.managerRentOverride).toBe("");
      expect(ctx.leaseBilling?.dailyRent).toBe(60);
    } finally { spy.mockRestore(); }
    row.application.managerRentOverride = "700";
    const negotiated = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(negotiated.dailyRent).toBeUndefined();
    expect(negotiated.monthlyRent).toBe(700);
  });

  it.each(["standard", "short_term"])("preserves manual resident deposit and move-in obligations for %s", (rentalType) => {
    const propertyId = `manual-obligation-${rentalType}`;
    const row = applicantRow(propertyId, `manual-obligation-${rentalType}@example.com`);
    row.manualResidentDetails = { ...row.manualResidentDetails, securityDeposit: 600, moveInFee: 80 } as DemoApplicantRow["manualResidentDetails"];
    row.application = { ...row.application!, rentalType: rentalType as "standard" | "short_term", leaseStart: "2026-09-02", leaseEnd: "2026-09-06", managerRentOverride: "" };
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), securityDeposit: "900", moveInFee: "150", shortTermDailyCost: "50", shortTermDeposit: "900", shortTermMoveInFee: "150",
      rooms: [{ ...emptyRoom(0), id: "room-1", monthlyRent: 825 }],
    }));
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.securityDeposit).toBe(600);
    expect(billing.securityDepositDue).toBe(600);
    expect(billing.moveInFee).toBe(80);
    expect(billing.moveInFeeDue).toBe(80);
    expect(billing.dueAtSigning).toBe(680);
  });

  it.each(["2026-09-01", "2026-09-22"])("does not collect paid first-period rent and utilities again for %s", (leaseStart) => {
    const propertyId = `paid-first-period-${leaseStart}`;
    const row = applicantRow(propertyId, `paid-first-period-${leaseStart}@example.com`);
    row.application = { ...row.application!, leaseStart };
    seedListing(propertyId, normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(), paymentAtSigningIncludes: ["first_month_rent", "first_month_utilities"],
      rooms: [{ ...emptyRoom(0), id: "room-1", monthlyRent: 800, utilitiesEstimate: "200" }],
    }));
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    expect(buildLeaseBillingSnapshot(row, MANAGER_ID).dueAtSigning).toBe(leaseStart.endsWith("01") ? 1000 : 300);
    for (const charge of readHouseholdCharges().filter((c) => c.applicationId === row.id && ["first_month_rent", "prorated_rent", "utilities", "prorated_utilities"].includes(c.kind) && !c.rentMonth)) {
      markHouseholdChargePaid(charge.id);
    }
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.firstPeriodRentDue).toBe(0);
    expect(billing.firstPeriodUtilitiesDue).toBe(0);
    expect(billing.dueAtSigning).toBe(0);
    const html = buildLeaseHtml({
      application: row.application!,
      submission: normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(), paymentAtSigningIncludes: ["first_month_rent", "first_month_utilities"],
      }),
      leaseBilling: billing,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
    }, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("No additional payment is due at signing");
    expect(html).not.toContain('font-weight:700">Due at signing</p><ul>');
  });

});
