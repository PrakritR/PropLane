/**
 * @vitest-environment jsdom
 *
 * Fee ownership (captain, Oct 3 2026): the Application fee is set on the APPLICATION, the Lease fee on the
 * LEASE (per lease type). A room's own value is a per-room override; clearing it returns the room to the
 * template. ONE resolver (`listing-placement-standard-fees.ts`) decides, so the preview, the checkout, the
 * recorded application-fee charge, the at-signing lease-fee charge and the billing snapshot agree.
 *
 *   room override -> template fee -> listing-level / account / legacy fallbacks
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { applicationFeeLabelForSelection, resolveApplicationFeeBasis } from "@/lib/application-fee-by-room";
import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  HOUSEHOLD_CHARGES_SESSION_KEY,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  recordSubmittedApplicationFeeCharge,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { buildListingQuote } from "@/lib/listing-quote";
import {
  mergeLongTermPrivateArrangementRow,
  mergeTermStandardFees,
  placementFeeLevel,
  placementFeeOptionsFor,
  resolvePlacementStandardFees,
} from "@/lib/listing-placement-standard-fees";
import { submissionWithDefaultLeasingSetup } from "@/lib/leasing-quick-add";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerBundleRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { leaseFeeDollarsFromOverlaidSubmission } from "@/lib/lease-at-signing";
import { submissionWithApplicationRoomFees } from "@/lib/room-term-fees";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-template-fees";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, monthlyRent: 1100, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

/**
 * Two rooms, the default leasing setup (Long-term + Short-term applications linked to their leases),
 * and template fees: Long-term application $45 / lease $200, Short-term application $25 / lease $90.
 * Listing-level application fee $35 is the fallback below the templates.
 */
function listing(opts: { withTemplateFees?: boolean; roomOne?: Partial<ManagerRoomSubmission>; roomTwo?: Partial<ManagerRoomSubmission> } = {}) {
  const withTemplateFees = opts.withTemplateFees ?? true;
  let sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "85";
  sub.applicationFee = "35";
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
  sub.rooms = [
    room({ id: "room-1", name: "Unit 2A", ...opts.roomOne }),
    room({ id: "room-2", name: "Unit 2B", ...opts.roomTwo }),
  ];
  sub = submissionWithDefaultLeasingSetup(normalizeManagerListingSubmissionV1(sub));
  if (withTemplateFees) {
    sub = {
      ...sub,
      propertyApplicationTemplates: readPropertyApplicationTemplates(sub).map((t) =>
        t.listingSeedKey === "primary"
          ? { ...t, feeCentsOverride: 4500 }
          : t.listingSeedKey === "short-term"
            ? { ...t, feeCentsOverride: 2500 }
            : t,
      ),
      propertyLeaseTemplates: readPropertyLeaseTemplates(sub).map((t) =>
        t.listingSeedKey === "primary"
          ? { ...t, leaseFeeCents: 20000 }
          : t.listingSeedKey === "short-term"
            ? { ...t, leaseFeeCents: 9000 }
            : t,
      ),
    };
  }
  return normalizeManagerListingSubmissionV1(sub);
}

const fees = (sub: ManagerListingSubmissionV1, roomId: string, term: string) => {
  const stay = term === SHORT_TERM_LEASE_TERM;
  return resolvePlacementStandardFees(
    sub,
    placementFeeOptionsFor(sub, { room: sub.rooms.find((r) => r.id === roomId), leaseTerm: term, rentalType: stay ? "short_term" : "standard" }),
  );
};

describe("the fee chain: room override -> template fee -> fallbacks", () => {
  it("a room with no value of its own takes its template's fee for each lease type", () => {
    const sub = listing();
    expect([fees(sub, "room-1", LONG_TERM_LEASE_TERM).applicationFee, fees(sub, "room-1", LONG_TERM_LEASE_TERM).leaseFee]).toEqual([45, 200]);
    expect([fees(sub, "room-1", SHORT_TERM_LEASE_TERM).applicationFee, fees(sub, "room-1", SHORT_TERM_LEASE_TERM).leaseFee]).toEqual([25, 90]);
  });

  it("a per-room override wins for that room only and never leaks to another room", () => {
    const base = listing();
    const overridden = {
      ...base,
      rooms: base.rooms.map((r) =>
        r.id === "room-2" ? mergeLongTermPrivateArrangementRow(r, { applicationFee: "60", leaseFee: "310" }) : r,
      ),
    };
    expect(fees(overridden, "room-2", LONG_TERM_LEASE_TERM)).toMatchObject({ applicationFee: 60, leaseFee: 310 });
    expect(fees(overridden, "room-1", LONG_TERM_LEASE_TERM)).toMatchObject({ applicationFee: 45, leaseFee: 200 });
    expect(placementFeeLevel(overridden, placementFeeOptionsFor(overridden, { room: overridden.rooms[1], leaseTerm: LONG_TERM_LEASE_TERM }), "applicationFee")).toBe("room");
    expect(placementFeeLevel(overridden, placementFeeOptionsFor(overridden, { room: overridden.rooms[0], leaseTerm: LONG_TERM_LEASE_TERM }), "applicationFee")).toBe("template");
  });

  it("a short-term override is per room and per lease type, and does not touch the long-term fee", () => {
    const base = listing();
    const overridden = {
      ...base,
      rooms: base.rooms.map((r) => (r.id === "room-1" ? mergeTermStandardFees(r, SHORT_TERM_LEASE_TERM, { applicationFee: "15" }) : r)),
    };
    expect(fees(overridden, "room-1", SHORT_TERM_LEASE_TERM).applicationFee).toBe(15);
    expect(fees(overridden, "room-1", LONG_TERM_LEASE_TERM).applicationFee).toBe(45);
    expect(fees(overridden, "room-2", SHORT_TERM_LEASE_TERM).applicationFee).toBe(25);
  });

  it("clearing the override returns the room to the template default", () => {
    const base = listing();
    const set = {
      ...base,
      rooms: base.rooms.map((r) => (r.id === "room-1" ? mergeLongTermPrivateArrangementRow(r, { applicationFee: "60" }) : r)),
    };
    expect(fees(set, "room-1", LONG_TERM_LEASE_TERM).applicationFee).toBe(60);
    const cleared = {
      ...set,
      rooms: set.rooms.map((r) => (r.id === "room-1" ? mergeLongTermPrivateArrangementRow(r, { applicationFee: "" }) : r)),
    };
    expect(fees(cleared, "room-1", LONG_TERM_LEASE_TERM).applicationFee).toBe(45);
    const clearedStay = mergeTermStandardFees(
      mergeTermStandardFees(base.rooms[0]!, SHORT_TERM_LEASE_TERM, { applicationFee: "15" }),
      SHORT_TERM_LEASE_TERM,
      { applicationFee: "" },
    );
    expect(clearedStay.termPricing).toBeUndefined();
  });

  it("a template fee of 0 is a real answer (free) and beats the listing-level fee", () => {
    const base = listing();
    const free = {
      ...base,
      propertyApplicationTemplates: readPropertyApplicationTemplates(base).map((t) => (t.listingSeedKey === "primary" ? { ...t, feeCentsOverride: 0 } : t)),
    };
    expect(fees(free, "room-1", LONG_TERM_LEASE_TERM).applicationFee).toBe(0);
    expect(fees(free, "room-1", LONG_TERM_LEASE_TERM).applicationFeeExplicit).toBe(true);
  });

  it("with no template fee the existing fallbacks are untouched (listing-level, then none)", () => {
    const bare = listing({ withTemplateFees: false });
    expect(fees(bare, "room-1", LONG_TERM_LEASE_TERM)).toMatchObject({ applicationFee: 35, applicationFeeExplicit: false, leaseFee: 0 });
  });

  it("the applicant's own application template picks whose fee applies", () => {
    const base = listing();
    const custom = { ...readPropertyApplicationTemplates(base)[0]!, id: "app-custom", listingSeedKey: undefined, label: "Custom", feeCentsOverride: 1000 };
    const sub = { ...base, propertyApplicationTemplates: [...readPropertyApplicationTemplates(base), custom] };
    const withId = resolvePlacementStandardFees(
      sub,
      placementFeeOptionsFor(sub, { room: sub.rooms[0], leaseTerm: LONG_TERM_LEASE_TERM, applicationTemplateId: "app-custom" }),
    );
    expect(withId.applicationFee).toBe(10);
  });

  it("a bundle placement reads the bundle's own fees, then the template", () => {
    const base = listing();
    const bundle: ManagerBundleRow = {
      id: "bundle-1",
      label: "Both rooms",
      price: "2000",
      strikethrough: "",
      promo: "",
      roomsLine: "",
      termPricing: { [LONG_TERM_LEASE_TERM]: { applicationFee: "80", leaseFee: "400" } },
    };
    const sub = { ...base, bundles: [bundle] };
    const own = resolvePlacementStandardFees(sub, placementFeeOptionsFor(sub, { bundle, leaseTerm: LONG_TERM_LEASE_TERM }));
    expect([own.applicationFee, own.leaseFee]).toEqual([80, 400]);
    const bare = { ...sub, bundles: [{ ...bundle, termPricing: undefined }] };
    const fallback = resolvePlacementStandardFees(bare, placementFeeOptionsFor(bare, { bundle: bare.bundles[0], leaseTerm: LONG_TERM_LEASE_TERM }));
    expect([fallback.applicationFee, fallback.leaseFee]).toEqual([45, 200]);
    // The lease overlay bills the bundle's lease fee as a one-time Lease fee row.
    const overlaid = submissionWithApplicationRoomFees(sub, { bundleId: "bundle-1" }, { leaseTerm: LONG_TERM_LEASE_TERM, rentalType: "standard" });
    expect(leaseFeeDollarsFromOverlaidSubmission(overlaid)).toBe(400);
  });
});

/* ───────────── preview == checkout == recorded charge == lease-fee charge ───────────── */

function checkoutDb(sub: ManagerListingSubmissionV1): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return { data: { manager_user_id: MANAGER_ID, property_data: { listingSubmission: sub } }, error: null };
      }
      if (table === "manager_automation_settings") {
        return { data: { row_data: { applicationSettings: { applicationFeeCents: 5000 } } }, error: null };
      }
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

function seed(propertyId: string, sub: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "Cascade Lofts",
    tagline: "",
    address: "100 Oak St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 1,
    baths: 1,
    rentLabel: "$1,100/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Cascade Lofts",
    unitLabel: "Unit 2A",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: sub,
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicant(propertyId: string, email: string, roomId: string, kind: "long" | "short", applicationTemplateId?: string): DemoApplicantRow {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    id: `app-${email}`,
    name: "Fee Tenant",
    email,
    property: "Cascade Lofts",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: choice,
    managerUserId: MANAGER_ID,
    signedMonthlyRent: 1100,
    application: {
      propertyId,
      roomChoice1: choice,
      fullLegalName: "Fee Tenant",
      ...(applicationTemplateId ? { applicationTemplateId } : {}),
      ...(kind === "short"
        ? { rentalType: "short_term", leaseTerm: SHORT_TERM_LEASE_TERM, leaseStart: "2026-03-10", leaseEnd: "2026-03-16" }
        : { rentalType: "standard", leaseTerm: LONG_TERM_LEASE_TERM, leaseStart: "2026-08-01", leaseEnd: "2027-07-31" }),
    },
  } as unknown as DemoApplicantRow;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
});

describe("preview == checkout == recorded charge, with and without a room override", () => {
  for (const scenario of ["no override", "room override"] as const) {
    for (const kind of ["long", "short"] as const) {
      it(`${scenario}, ${kind}-term: the quote, the server amount and the booked charge are one number`, async () => {
        const base = listing();
        const sub =
          scenario === "no override"
            ? base
            : {
                ...base,
                rooms: base.rooms.map((r) =>
                  r.id === "room-1"
                    ? kind === "long"
                      ? mergeLongTermPrivateArrangementRow(r, { applicationFee: "60" })
                      : mergeTermStandardFees(r, SHORT_TERM_LEASE_TERM, { applicationFee: "15" })
                    : r,
                ),
              };
        const propertyId = `prop-chain-${scenario.replace(" ", "-")}-${kind}`;
        seed(propertyId, sub);
        const term = kind === "long" ? LONG_TERM_LEASE_TERM : SHORT_TERM_LEASE_TERM;
        const rentalType = kind === "long" ? "standard" : "short_term";
        const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`;

        // The preview: the label the manager and the listing show.
        const previewLabel = applicationFeeLabelForSelection(sub, { roomChoice1: choice, leaseTerm: term, rentalType });
        const basis = resolveApplicationFeeBasis(sub, { roomChoice1: choice, leaseTerm: term, rentalType });
        // The server's own amount at checkout.
        const resolved = await resolveApplicationFeeProperty(
          checkoutDb(sub),
          { propertyId, managerUserId: MANAGER_ID, rentalType, leaseTerm: term, roomChoice1: choice },
          { allowZeroFee: true },
        );
        expect(resolved.ok).toBe(true);
        const checkoutCents = resolved.ok ? resolved.value.applicationFeeCents : -1;
        // The charge recorded when the application is submitted.
        const email = `chain-${scenario.replace(" ", "")}-${kind}@example.com`;
        removeResidentHouseholdPaymentData(email);
        const row = applicant(propertyId, email, "room-1", kind);
        recordSubmittedApplicationFeeCharge(row, MANAGER_ID);
        const recorded = readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "application_fee");

        const expectedCents = scenario === "no override" ? (kind === "long" ? 4500 : 2500) : kind === "long" ? 6000 : 1500;
        expect(basis.roomTermCents).toBe(expectedCents);
        expect(previewLabel).toBe(`$${expectedCents / 100}`);
        expect(checkoutCents).toBe(expectedCents);
        expect(recorded?.amountLabel).toBe(`$${(expectedCents / 100).toFixed(2)}`);
        expect(resolved.ok && resolved.value.feeSource).toBe(scenario === "no override" ? "template" : "room_term");
      });
    }
  }

  it("an applicant who filled in a specific application is charged that application's fee", async () => {
    const base = listing();
    const custom = { ...readPropertyApplicationTemplates(base)[0]!, id: "app-custom", listingSeedKey: undefined, label: "Custom", feeCentsOverride: 1000 };
    const sub = { ...base, propertyApplicationTemplates: [...readPropertyApplicationTemplates(base), custom] };
    const propertyId = "prop-chain-custom";
    seed(propertyId, sub);
    const resolved = await resolveApplicationFeeProperty(
      checkoutDb(sub),
      { propertyId, managerUserId: MANAGER_ID, leaseTerm: LONG_TERM_LEASE_TERM, roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`, applicationTemplateId: "app-custom" },
      { allowZeroFee: true },
    );
    expect(resolved.ok && resolved.value.applicationFeeCents).toBe(1000);
    const email = "chain-custom@example.com";
    removeResidentHouseholdPaymentData(email);
    recordSubmittedApplicationFeeCharge(applicant(propertyId, email, "room-1", "long", "app-custom"), MANAGER_ID);
    expect(readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "application_fee")?.amountLabel).toBe("$10.00");
  });

  it("a bundle applicant is charged the bundle's own application fee at checkout", async () => {
    const base = listing();
    const bundle: ManagerBundleRow = {
      id: "bundle-1",
      label: "Both rooms",
      price: "2000",
      strikethrough: "",
      promo: "",
      roomsLine: "",
      termPricing: { [LONG_TERM_LEASE_TERM]: { applicationFee: "80" } },
    };
    const sub = { ...base, bundles: [bundle] };
    const resolved = await resolveApplicationFeeProperty(
      checkoutDb(sub),
      { propertyId: "prop-chain-bundle", managerUserId: MANAGER_ID, leaseTerm: LONG_TERM_LEASE_TERM, bundleId: "bundle-1" },
      { allowZeroFee: true },
    );
    expect(resolved.ok && resolved.value.applicationFeeCents).toBe(8000);
    expect(resolved.ok && resolved.value.feeSource).toBe("room_term");
  });

  it("the account fee applies only when neither the room nor a template sets one", async () => {
    const bare = listing({ withTemplateFees: false });
    const noListingFee = { ...bare, applicationFee: "" };
    const resolved = await resolveApplicationFeeProperty(
      checkoutDb(noListingFee),
      { propertyId: "prop-chain-account", managerUserId: MANAGER_ID, leaseTerm: LONG_TERM_LEASE_TERM, roomChoice1: `prop-chain-account${LISTING_ROOM_CHOICE_SEP}room-1` },
      { allowZeroFee: true },
    );
    expect(resolved.ok && resolved.value.applicationFeeCents).toBe(5000);
    expect(resolved.ok && resolved.value.feeSource).toBe("account");
  });
});

describe("the lease fee comes from the lease of the signed lease type", () => {
  it("charges the lease template's fee per lease type, and a room override for that room only", () => {
    const base = listing();
    const sub = {
      ...base,
      rooms: base.rooms.map((r) => (r.id === "room-2" ? mergeLongTermPrivateArrangementRow(r, { leaseFee: "310" }) : r)),
    };
    const propertyId = "prop-lease-fee";
    seed(propertyId, sub);
    const leaseFeeFor = (email: string, roomId: string, kind: "long" | "short") => {
      removeResidentHouseholdPaymentData(email);
      recordApprovedApplicationCharges(applicant(propertyId, email, roomId, kind), MANAGER_ID, true, { leaseExecuted: true });
      return readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "lease_fee")?.amountLabel;
    };
    expect(leaseFeeFor("lf-long-1@example.com", "room-1", "long")).toBe("$200.00");
    expect(leaseFeeFor("lf-long-2@example.com", "room-2", "long")).toBe("$310.00");
    expect(leaseFeeFor("lf-short-1@example.com", "room-1", "short")).toBe("$90.00");
  });

  it("the quote's lease line equals the lease fee charged", () => {
    const sub = listing();
    const propertyId = "prop-lease-quote";
    seed(propertyId, sub);
    const email = "lf-quote@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant(propertyId, email, "room-1", "long"), MANAGER_ID, true, { leaseExecuted: true });
    const charged = readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "lease_fee")?.amountLabel;
    const quoted = buildListingQuote(sub, { roomId: "room-1", leaseTerm: LONG_TERM_LEASE_TERM }).signingLines.find((l) => /lease fee/i.test(l.label))?.amount;
    expect(charged).toBe("$200.00");
    expect(quoted).toBe(200);
    // The billing snapshot reads the same overlay, so it carries the same lease fee.
    const snapshot = buildLeaseBillingSnapshot(applicant(propertyId, "lf-snap@example.com", "room-1", "long"), MANAGER_ID);
    expect(snapshot.leaseFee).toBe(200);
  });
});
