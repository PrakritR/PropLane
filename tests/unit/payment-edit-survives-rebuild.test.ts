/**
 * @vitest-environment jsdom
 *
 * "Saving edit payment doesn't save" (captain, Sep 20 2026, native app): the Edit payment
 * sheet's Save spun forever, and even when the request did return the typed figure was
 * gone a moment later.
 *
 * Two faults, two contracts:
 *  1. An awaited charge write is BOUNDED. A request that settles neither way (a stalled
 *     WebView fetch) resolves "failed" after the bound, so the button re-arms and the
 *     browser copy rolls back instead of claiming a save that never happened.
 *  2. A hand-typed amount outranks the listing for EVERY charge kind. The "prorated first
 *     month's rent" row is created from the application, and the rebuild used to wipe
 *     every pending application row before re-deriving it — the guard that kept a typed
 *     figure covered only plain rent and utilities.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  setHouseholdWriteTimeoutMsForTests,
  updateHouseholdChargeAmount,
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

const MANAGER_ID = "mgr-edit-survives";

function seed(propertyId: string): MockProperty {
  const sub = createDefaultListingSubmission();
  const base = sub.rooms[0]!;
  sub.rooms = [{ ...base, id: "room-2", name: "Room 2", monthlyRent: 1455, utilitiesEstimate: "" } as ManagerRoomSubmission];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = [];
  const property: MockProperty = {
    id: propertyId,
    title: "8th Ave House",
    tagline: "",
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,455/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "8th Ave House",
    unitLabel: "Room 2",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

// Sep 21 → Sep 20: 10/30 days from lease start → $485.00 prorated first month.
function applicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Sohan Vivek Naik",
    email,
    property: "8th Ave House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-2`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-2`,
      rentalType: "standard",
      leaseStart: "2026-09-21",
      leaseEnd: "2027-09-20",
      fullLegalName: "Sohan Vivek Naik",
    },
  } as unknown as DemoApplicantRow;
}

function proratedRows(email: string) {
  return readHouseholdCharges().filter(
    (c) => c.residentEmail.toLowerCase() === email && c.kind === "prorated_rent",
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  setHouseholdWriteTimeoutMsForTests(null);
  window.history.replaceState({}, "", "/portal/payments");
});

describe("an awaited charge write is bounded", () => {
  it("resolves failed and rolls back when the request never settles", async () => {
    setHouseholdWriteTimeoutMsForTests(40);
    // A fetch that only ever answers the abort — the stalled-WebView shape.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      ),
    );
    const email = "stalled@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stalled";
    seed(propertyId);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    const row = proratedRows(email)[0];
    expect(row?.amountLabel).toBe("$485.00");

    const handle = updateHouseholdChargeAmount(row!.id, 500, MANAGER_ID);
    expect(handle).not.toBeNull();
    await expect(handle!.confirmed).resolves.toBe("failed");
    expect(proratedRows(email)[0]?.amountLabel).toBe("$485.00");
  });
});

describe("a typed prorated amount survives a forced rebuild", () => {
  it("keeps the manager's $500 on the prorated first month when charges regenerate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));
    const email = "sohan@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-survives";
    seed(propertyId);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    const row = proratedRows(email)[0];
    expect(row?.amountLabel).toBe("$485.00");

    const handle = updateHouseholdChargeAmount(row!.id, 500, MANAGER_ID);
    await expect(handle!.confirmed).resolves.toBe("saved");
    expect(proratedRows(email)[0]?.amountLabel).toBe("$500.00");

    // The forced rebuild is what the Save path and "Regenerate" both run.
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });

    const after = proratedRows(email);
    expect(after).toHaveLength(1);
    expect(after[0]?.amountLabel).toBe("$500.00");
    expect(after[0]?.manualAmountOverrideAt).toBeTruthy();
  });
});
