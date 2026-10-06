/**
 * @vitest-environment jsdom
 *
 * The SERVER is the single source of truth for the rental application fee
 * (`/api/public/application-fee-preview` → `effectiveApplicationFeeCents`,
 * consulting the manager-level fee). The applicant's GATE, the DISPLAYED
 * amount, and the BOOKED charge must all derive from that one answer and can
 * never disagree — a prior review round found the feature silently collected
 * NOTHING because the client gate read only the per-listing fee.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn().mockResolvedValue({ tier: "free" }),
}));
vi.mock("@/lib/manager-manual-payment-settings", () => ({
  loadManagerManualPaymentSettings: vi.fn().mockResolvedValue({ serviceFeePayer: "resident" }),
}));
import {
  ensurePendingApplicationFeeCharge,
  readHouseholdCharges,
  recordApplicationCharges,
  removeResidentHouseholdPaymentData,
  seedDemoHouseholdCharges,
  findApplicationFeeCharge,
  applicationFeeChargeIdForApplication,
} from "@/lib/household-charges";
import { residentApplicationFeeGate } from "@/lib/rental-application/application-policy";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import {
  resolveApplicationFeeItemization,
  resolveApplicationFeeProperty,
} from "@/lib/application-fee-checkout.server";
import { LEGACY_DEFAULT_APPLICATION_FEE_CENTS } from "@/lib/manager-application-settings";
import type { SupabaseClient } from "@supabase/supabase-js";

const MANAGER_ID = "mgr-fee-truth";

function seedListing(propertyId: string, applicationFee: string): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.applicationFee = applicationFee;
  const property: MockProperty = {
    id: propertyId,
    title: "Fee Truth Flat",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Fee Truth Flat",
    unitLabel: "Unit 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function appFeeCharges(email: string) {
  return readHouseholdCharges().filter(
    (c) => c.residentEmail.toLowerCase() === email.toLowerCase() && c.kind === "application_fee",
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("residentApplicationFeeGate — server fee overrides the per-listing catalog", () => {
  it("merges pending and paid representations of the same application without replacing the paid source", () => {
    const propertyId = "prop-app-source", email = "same@example.com";
    seedListing(propertyId, "$50");
    const pending = { id: applicationFeeChargeIdForApplication("app-same"), createdAt: "2026-01-01T00:00:00Z",
      applicationId: "app-same", residentEmail: email, residentName: "Resident", residentUserId: null,
      propertyId, propertyLabel: "Fee Truth Flat", managerUserId: MANAGER_ID,
      kind: "application_fee" as const, title: "Application fee", amountLabel: "$50.00",
      balanceLabel: "$50.00", status: "pending" as const, blocksLeaseUntilPaid: false };
    const paid = { ...pending, id: "hc_provider_source_same", status: "paid" as const,
      balanceLabel: "$0.00", paidAt: "2026-01-02T00:00:00Z", paidAmountCents: 5175,
      stripeCheckoutSessionId: "cs_same" };
    const other = { ...pending, id: applicationFeeChargeIdForApplication("app-other"), applicationId: "app-other" };
    seedDemoHouseholdCharges([pending, paid, other]);
    const charges = appFeeCharges(email);
    expect(charges).toHaveLength(2);
    expect(charges.find((charge) => charge.applicationId === "app-same"))
      .toMatchObject({ id: paid.id, status: "paid", stripeCheckoutSessionId: "cs_same" });
    expect(charges.find((charge) => charge.applicationId === "app-other")?.status).toBe("pending");
  });
  it("keeps every-time application fees distinct for two drafts on one listing", () => {
    const propertyId = "prop-every-time-exact", email = "repeat@example.com";
    seedListing(propertyId, "$50");
    const paid = { id: applicationFeeChargeIdForApplication("app-one"), createdAt: "2026-01-01T00:00:00Z",
      applicationId: "app-one", residentEmail: email, residentName: "Resident", residentUserId: null,
      propertyId, propertyLabel: "Fee Truth Flat", managerUserId: MANAGER_ID,
      kind: "application_fee" as const, title: "Application fee", amountLabel: "$50.00",
      balanceLabel: "$0.00", status: "paid" as const, paidAt: "2026-01-02T00:00:00Z",
      paidAmountCents: 5175, stripeCheckoutSessionId: "cs_app_one", blocksLeaseUntilPaid: false };
    const second = { ...paid, id: applicationFeeChargeIdForApplication("app-two"),
      applicationId: "app-two", status: "pending" as const, paidAt: undefined,
      paidAmountCents: undefined, stripeCheckoutSessionId: undefined, balanceLabel: "$50.00" };
    seedDemoHouseholdCharges([paid, second]);
    expect(appFeeCharges(email)).toHaveLength(2);
    expect(findApplicationFeeCharge(email, propertyId, null, "app-one")?.id).toBe(paid.id);
    expect(findApplicationFeeCharge(email, propertyId, null, "app-two")?.id).toBe(second.id);
    expect(residentApplicationFeeGate({ propertyId, residentEmail: email, applicationId: "app-one",
      chargePolicy: "every_time", serverFeeCents: 5000, serverFeeWaived: false }).paid).toBe(true);
    expect(residentApplicationFeeGate({ propertyId, residentEmail: email, applicationId: "app-two",
      chargePolicy: "every_time", serverFeeCents: 5000, serverFeeWaived: false }).paid).toBe(false);
    expect(findApplicationFeeCharge(email, propertyId, null, "app-three")).toBeUndefined();
  });
  it("gates a NEW listing (empty per-listing fee) when the manager-level fee is set", () => {
    // (a) The listing form no longer carries a fee input, so a new listing's
    // stored applicationFee is "" — the server's manager-level fee must still
    // gate the applicant instead of resolving amount=0 and collecting nothing.
    const pid = "prop-fee-truth-new";
    seedListing(pid, "");
    const gate = residentApplicationFeeGate({
      propertyId: pid,
      residentEmail: "a@example.com",
      serverFeeCents: 7500,
    });
    expect(gate.needsFee).toBe(true);
    expect(gate.amount).toBe(75);
    expect(gate.displayLabel).toBe("$75.00");
  });

  it("passes the applicant straight through when the manager set an explicit $0 fee", () => {
    // (b) A manager-set 0 means free applications — no payment step, no
    // dead-end — even when the listing still carries a grandfathered fee.
    const pid = "prop-fee-truth-zero";
    seedListing(pid, "$50");
    const gate = residentApplicationFeeGate({
      propertyId: pid,
      residentEmail: "a@example.com",
      serverFeeCents: 0,
    });
    expect(gate.needsFee).toBe(false);
    expect(gate.paid).toBe(true);
  });

  it("uses the manager fee, not the grandfathered listing fee, when they differ", () => {
    // (c) gate half: one amount everywhere — never two.
    const pid = "prop-fee-truth-differs";
    seedListing(pid, "$50");
    const gate = residentApplicationFeeGate({
      propertyId: pid,
      residentEmail: "a@example.com",
      serverFeeCents: 7500,
    });
    expect(gate.amount).toBe(75);
    expect(gate.displayLabel).toBe("$75.00");
  });

  it("keeps the grandfathered listing fee when no server answer is supplied (demo fallback)", () => {
    const pid = "prop-fee-truth-fallback";
    seedListing(pid, "$50");
    const gate = residentApplicationFeeGate({
      propertyId: pid,
      residentEmail: "a@example.com",
    });
    expect(gate.needsFee).toBe(true);
    expect(gate.amount).toBe(50);
  });
});

describe("booked charge — server fee override", () => {
  it("books the SERVER amount when it differs from the grandfathered listing fee", () => {
    // (c) booked-charge half: the pending line equals what Stripe charges.
    const email = "book-differs@example.com";
    removeResidentHouseholdPaymentData(email);
    const pid = "prop-fee-truth-book";
    seedListing(pid, "$50");
    const charge = ensurePendingApplicationFeeCharge({
      residentEmail: email,
      residentName: "Dana",
      residentUserId: null,
      propertyId: pid,
      feeAmountOverride: 75,
    });
    expect(charge?.amountLabel).toBe("$75.00");
    expect(appFeeCharges(email)).toHaveLength(1);
  });

  it("books NOTHING for a $0 server fee — including the uncatalogued-listing $50 fallback", () => {
    const email = "book-zero@example.com";
    removeResidentHouseholdPaymentData(email);
    const charge = ensurePendingApplicationFeeCharge({
      residentEmail: email,
      residentName: "Dana",
      residentUserId: null,
      propertyId: "prop-not-in-catalog",
      feeAmountOverride: 0,
    });
    expect(charge).toBeNull();
    recordApplicationCharges(
      {
        residentEmail: email,
        residentName: "Dana",
        residentUserId: null,
        propertyId: "prop-not-in-catalog",
      },
      { applicationFeeAmount: 0 },
    );
    expect(appFeeCharges(email)).toHaveLength(0);
  });

  it("books the server amount instead of the legacy $50 fallback for an uncatalogued listing", () => {
    const email = "book-uncatalogued@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApplicationCharges(
      {
        residentEmail: email,
        residentName: "Dana",
        residentUserId: null,
        propertyId: "prop-not-in-catalog-2",
      },
      { applicationFeeAmount: 75 },
    );
    const charges = appFeeCharges(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amountLabel).toBe("$75.00");
  });

  it("books no application-fee line at all for a waived submission", () => {
    const email = "book-waived@example.com";
    removeResidentHouseholdPaymentData(email);
    const pid = "prop-fee-truth-waived";
    seedListing(pid, "$50");
    recordApplicationCharges(
      {
        residentEmail: email,
        residentName: "Dana",
        residentUserId: null,
        propertyId: pid,
      },
      { skipApplicationFee: true },
    );
    expect(appFeeCharges(email)).toHaveLength(0);
  });
});

function dbWith(managerFeeCents: number | null, listingFee: string): SupabaseClient {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        if (table === "manager_property_records") {
          return {
            data: {
              manager_user_id: MANAGER_ID,
              property_data: {
                listingSubmission: { v: 1, applicationFee: listingFee, rooms: [], bathrooms: [] },
              },
            },
            error: null,
          };
        }
        if (table === "manager_automation_settings") {
          return {
            data:
              managerFeeCents === null
                ? null
                : { row_data: { applicationSettings: { applicationFeeCents: managerFeeCents } } },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

// Captain, 2026-10-03: the fee follows the chosen room + lease type, then the listing-level
// fee, then the Application system setting (docs/agents/resident-payments.md). A typed 0 at
// any level is free. By-room coverage lives in tests/unit/application-fee-by-room.test.ts.
describe("resolveApplicationFeeProperty — listing-level fee, then the account-wide fee", () => {
  it("charges the account-wide fee for a listing that sets nothing", async () => {
    const res = await resolveApplicationFeeProperty(dbWith(7500, ""), {
      propertyId: "p1",
      managerUserId: MANAGER_ID,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(7500);
  });

  it("a per-listing fee wins over the account-wide fee", async () => {
    const res = await resolveApplicationFeeProperty(dbWith(7500, "$50"), {
      propertyId: "p1",
      managerUserId: MANAGER_ID,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(5000);
  });

  it("a per-listing $0 makes the listing free even while the account charges a fee", async () => {
    const res = await resolveApplicationFeeProperty(
      dbWith(7500, "$0"),
      { propertyId: "p1", managerUserId: MANAGER_ID },
      { allowZeroFee: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(0);
  });

  it("the preview answers an account-wide $0 as ok/0 (free) when the listing sets nothing", async () => {
    const res = await resolveApplicationFeeProperty(
      dbWith(0, ""),
      { propertyId: "p1", managerUserId: MANAGER_ID },
      { allowZeroFee: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(0);
  });

  it("the checkout mint refuses a free fee — there is nothing to collect", async () => {
    const res = await resolveApplicationFeeProperty(dbWith(0, ""), {
      propertyId: "p1",
      managerUserId: MANAGER_ID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_APPLICATION_FEE");
  });

  it("falls back to the legacy default when nothing at all is set", async () => {
    const res = await resolveApplicationFeeProperty(dbWith(null, ""), {
      propertyId: "p1",
      managerUserId: MANAGER_ID,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(LEGACY_DEFAULT_APPLICATION_FEE_CENTS);
  });

  it("a stay reads the listing-level short-term fee, not the long-term one", async () => {
    const db = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => {
          if (table === "manager_property_records") {
            return {
              data: {
                manager_user_id: MANAGER_ID,
                property_data: {
                  listingSubmission: {
                    v: 1,
                    applicationFee: "$50",
                    shortTermApplicationFee: "$35",
                    rooms: [],
                    bathrooms: [],
                  },
                },
              },
              error: null,
            };
          }
          if (table === "manager_automation_settings") {
            return { data: { row_data: { applicationSettings: { applicationFeeCents: 7500 } } }, error: null };
          }
          return { data: null, error: null };
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const res = await resolveApplicationFeeProperty(db, {
      propertyId: "p1",
      managerUserId: MANAGER_ID,
      rentalType: "short_term",
    });
    expect(res.ok).toBe(true);
    // The listing has to offer stays for the short-term row to apply; this one does not,
    // so a client naming a stay cannot reach it and the long-term listing fee applies.
    if (res.ok) expect(res.value.applicationFeeCents).toBe(5000);
  });
});

describe("resolveApplicationFeeItemization — $0 fee never dead-ends", () => {
  it("returns a normal all-zero itemization for a 0 fee", async () => {
    const stubDb = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: null });
        return chain;
      },
    } as unknown as SupabaseClient;
    const itemization = await resolveApplicationFeeItemization(stubDb, MANAGER_ID, 0);
    expect(itemization.applicationFeeCents).toBe(0);
    expect(itemization.serviceFeeCents).toBe(0);
    expect(itemization.totalCents).toBe(0);
  });
});
