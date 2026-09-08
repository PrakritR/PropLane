/**
 * @vitest-environment jsdom
 *
 * Per-room security deposit → approved-application charge generation.
 *
 * The listing wizard now lets each room carry its OWN security deposit
 * (`ManagerRoomSubmission.securityDeposit`). This suite pins the money-path contract
 * for `recordApprovedApplicationCharges`:
 *   - a room with its own deposit bills THAT deposit (room-first precedence, like rent),
 *   - a room with no per-room deposit falls back to the shared listing deposit so
 *     existing listings bill exactly as before,
 *   - the manager's negotiated deposit override still beats the per-room value.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-room-deposit";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room 1",
    floor: "Main",
    availability: "Available now",
    moveInAvailableDate: "2026-01-01",
    monthlyRent: 1200,
    utilitiesEstimate: "",
    ...over,
  } as ManagerRoomSubmission;
}

function seedListing(
  propertyId: string,
  r: ManagerRoomSubmission,
  sharedSecurityDeposit: string,
  sharedMoveInFee = "",
): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [r];
  sub.securityDeposit = sharedSecurityDeposit;
  sub.moveInFee = sharedMoveInFee;
  const property: MockProperty = {
    id: propertyId,
    title: "Deposit Test House",
    tagline: "Rooms",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Deposit Test House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicantRow(
  propertyId: string,
  roomId: string,
  email: string,
  over: Partial<DemoApplicantRow["application"]> = {},
): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Deposit Test House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`,
      leaseStart: "2026-03-10",
      leaseEnd: "2027-03-09",
      fullLegalName: "Dana Tenant",
      ...over,
    },
  } as unknown as DemoApplicantRow;
}

function depositCharge(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .find((c) => c.kind === "security_deposit");
}

function moveInCharge(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .find((c) => c.kind === "move_in_fee");
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("per-room security deposit — approved-application charges", () => {
  it("bills the room's own deposit when it is set (room wins over the shared deposit)", () => {
    const email = "room-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-room-deposit";
    seedListing(propertyId, room({ securityDeposit: "1500" }), "1000");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });

    expect(depositCharge(email)?.amountLabel).toBe("$1,500.00");
  });

  it("falls back to the shared listing deposit when the room has none (existing listings unchanged)", () => {
    const email = "shared-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-shared-deposit";
    // Room carries no per-room deposit → the $1,000 shared deposit must bill, exactly as before.
    seedListing(propertyId, room({ securityDeposit: undefined }), "1000");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });

    expect(depositCharge(email)?.amountLabel).toBe("$1,000.00");
  });

  it("lets the manager's negotiated deposit override beat the per-room deposit", () => {
    const email = "override-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-override-deposit";
    seedListing(propertyId, room({ securityDeposit: "1500" }), "1000");

    recordApprovedApplicationCharges(
      applicantRow(propertyId, "room-1", email, { managerSecurityDepositOverride: "2000" }),
      MANAGER_ID,
      true,
      { leaseExecuted: true },
    );

    expect(depositCharge(email)?.amountLabel).toBe("$2,000.00");
  });
});

describe("per-room move-in fee — room wins over the shared move-in, never both", () => {
  it("bills the room's own move-in fee when set", () => {
    const email = "room-movein@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-room-movein";
    seedListing(propertyId, room({ moveInFee: "300" }), "1000", "150");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });

    // Exactly ONE move-in charge, at the room's amount — the shared $150 does not also bill.
    const all = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "move_in_fee",
    );
    expect(all).toHaveLength(1);
    expect(moveInCharge(email)?.amountLabel).toBe("$300.00");
  });

  it("falls back to the shared move-in fee when the room has none", () => {
    const email = "shared-movein@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-shared-movein";
    seedListing(propertyId, room({ moveInFee: undefined }), "1000", "150");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });

    expect(moveInCharge(email)?.amountLabel).toBe("$150.00");
  });
});

// The create path and the sync-patch path (syncPendingApprovedChargesFromListing, which runs
// on a non-forced re-record when pending charges already exist) must agree on room-first
// precedence — otherwise a live re-sync silently patches a per-room deposit down to the
// listing amount. This is the exact case flagged during the prakrit merge.
describe("live re-sync keeps per-room amounts (sync-patch room-first precedence)", () => {
  it("does not patch a per-room deposit down to the listing deposit on re-sync", () => {
    const email = "resync-deposit@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-resync-deposit";
    seedListing(propertyId, room({ securityDeposit: "1500" }), "1000");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });
    expect(depositCharge(email)?.amountLabel).toBe("$1,500.00");

    // Non-forced re-record triggers the sync-patch layer; it must NOT overwrite the per-room
    // $1,500 with the $1,000 listing deposit.
    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, false, { leaseExecuted: true });
    expect(depositCharge(email)?.amountLabel).toBe("$1,500.00");
  });

  it("does not patch a per-room move-in fee down to the listing move-in on re-sync", () => {
    const email = "resync-movein@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-resync-movein";
    seedListing(propertyId, room({ moveInFee: "300" }), "1000", "150");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, true, { leaseExecuted: true });
    expect(moveInCharge(email)?.amountLabel).toBe("$300.00");

    recordApprovedApplicationCharges(applicantRow(propertyId, "room-1", email), MANAGER_ID, false, { leaseExecuted: true });
    expect(moveInCharge(email)?.amountLabel).toBe("$300.00");
  });
});
