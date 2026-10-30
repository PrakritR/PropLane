/**
 * Short stays (Short-Term Stay, Airbnb) never fall back to the account application fee:
 * with nothing set in Pricing or on the form the fee is 0. Long-term is unchanged. The fee the checkout
 * charges (`resolveApplicationFeeProperty`) and the fee the Application tab shows
 * (`applicationFeeFactForTerms`) are the same number for every combination.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: vi.fn() }));
vi.mock("@/lib/manager-manual-payment-settings", () => ({ loadManagerManualPaymentSettings: vi.fn() }));

import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { applicationFeeFactForTerms } from "@/lib/form-resolved-fee";
import { effectiveApplicationFeeCents } from "@/lib/manager-application-settings";
import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate } from "@/lib/property-application-templates";
import {
  AIRBNB_LEASE_TERM,
  isShortStayApplication,
  LONG_TERM_LEASE_TERM,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";

const PID = "prop_free";
const MGR = "mgr_free";
const TEMPLATE_ID = "tpl_form";

type Setup = "pricing" | "form" | "account" | "nothing" | "longfee";
const TERMS = [
  { name: "short-term", term: SHORT_TERM_LEASE_TERM, rentalType: "short_term" as const, stay: true },
  { name: "airbnb", term: AIRBNB_LEASE_TERM, rentalType: "short_term" as const, stay: true },
  { name: "long-term", term: LONG_TERM_LEASE_TERM, rentalType: "standard" as const, stay: false },
];
const SETUPS: Setup[] = ["pricing", "form", "account", "nothing", "longfee"];

function listing(setup: Setup, term: string): ManagerListingSubmissionV1 {
  const room = {
    ...emptyRoom(0),
    id: "r1",
    name: "r1",
    monthlyRent: 900,
    ...(setup === "longfee"
      ? { occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "40" }] }
      : setup === "pricing"
      ? term === LONG_TERM_LEASE_TERM
        ? { occupancyPrices: [{ count: 1, monthlyRent: 900, applicationFee: "15" }] }
        : { termPricing: { [term]: { applicationFee: "15" } } }
      : {}),
  };
  const tpl = {
    ...createPropertyApplicationTemplate({ kind: "short-term", label: "App" }),
    id: TEMPLATE_ID,
    ...(setup === "form" ? { feeCentsOverride: 2500 } : {}),
  };
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM, AIRBNB_LEASE_TERM],
    shortTermRentalsAllowed: true,
    airbnbRentalsAllowed: true,
    axisPaymentsEnabled: true,
    applicationFee: setup === "longfee" ? "35" : "",
    rooms: [room],
    propertyApplicationTemplates: [tpl],
  } as ManagerListingSubmissionV1);
}

function dbFor(sub: ManagerListingSubmissionV1, accountFeeCents: number | null): SupabaseClient {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        if (table === "manager_property_records") {
          return { data: { manager_user_id: MGR, property_data: { listingSubmission: sub } }, error: null };
        }
        if (table === "manager_automation_settings") {
          return {
            data: { row_data: { applicationSettings: { applicationFeeCents: accountFeeCents } } },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

function expected(setup: Setup, stay: boolean): number {
  if (setup === "pricing") return 1500;
  if (setup === "form") return 2500;
  if (setup === "longfee") return stay ? 0 : 4000;
  if (setup === "account") return stay ? 0 : 6000;
  return 0; // nothing configured = free (captain, 2026-10-29)
}

describe("short stays default to no application fee; charge == display", () => {
  for (const t of TERMS) {
    for (const setup of SETUPS) {
      it(`${t.name} x ${setup}`, async () => {
        const sub = listing(setup, t.term);
        const accountFee = setup === "account" ? 6000 : null;
        const res = await resolveApplicationFeeProperty(
          dbFor(sub, accountFee),
          {
            propertyId: PID,
            managerUserId: MGR,
            roomChoice1: `${PID}${LISTING_ROOM_CHOICE_SEP}r1`,
            leaseTerm: t.term,
            rentalType: t.rentalType,
            applicationTemplateId: TEMPLATE_ID,
          },
          { allowZeroFee: true },
        );
        if (!res.ok) throw new Error(res.error);
        const charged = res.value.applicationFeeCents;
        expect(charged).toBe(expected(setup, t.stay));

        const fact = applicationFeeFactForTerms(sub, [t.term], accountFee, {
          id: TEMPLATE_ID,
          feeCentsOverride: setup === "form" ? 2500 : null,
        });
        const shown = fact === "No fee" ? 0 : Math.round(Number(fact.replace("Application fee $", "")) * 100);
        expect(shown).toBe(charged);
      });
    }
  }

  it("a $0 short-term fee is not a checkout (422 NO_APPLICATION_FEE without allowZeroFee)", async () => {
    const sub = listing("account", SHORT_TERM_LEASE_TERM);
    const res = await resolveApplicationFeeProperty(dbFor(sub, 6000), {
      propertyId: PID,
      managerUserId: MGR,
      roomChoice1: `${PID}${LISTING_ROOM_CHOICE_SEP}r1`,
      leaseTerm: SHORT_TERM_LEASE_TERM,
      rentalType: "short_term",
    });
    expect(res).toMatchObject({ ok: false, status: 422, code: "NO_APPLICATION_FEE" });
  });

  it("the pure resolver: shortStay ignores the account default", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 6000, shortStay: true })).toBe(0);
    expect(effectiveApplicationFeeCents({ managerFeeCents: null, shortStay: true })).toBe(0);
    expect(effectiveApplicationFeeCents({ managerFeeCents: null })).toBe(0);
    expect(effectiveApplicationFeeCents({ managerFeeCents: 6000, templateFeeCentsOverride: 0, shortStay: true })).toBe(0);
  });

  it("isShortStayApplication", () => {
    expect(isShortStayApplication({ leaseTerm: SHORT_TERM_LEASE_TERM })).toBe(true);
    expect(isShortStayApplication({ leaseTerm: AIRBNB_LEASE_TERM })).toBe(true);
    expect(isShortStayApplication({ leaseTerm: LONG_TERM_LEASE_TERM })).toBe(false);
    // The lease term alone decides: a blank or unknown term is long-term.
    expect(isShortStayApplication({})).toBe(false);
    expect(isShortStayApplication({ leaseTerm: "" })).toBe(false);
    expect(isShortStayApplication({ leaseTerm: "Whatever" })).toBe(false);
  });

  // Exploit: the applicant-supplied rentalType must not turn a long-term term into a free stay.
  describe("rentalType short_term beside a non-stay lease term is long-term (house fee charged)", () => {
    for (const term of [LONG_TERM_LEASE_TERM, "", "Not-A-Term"]) {
      for (const setup of ["nothing", "account", "longfee"] as Setup[]) {
        it(`term ${JSON.stringify(term)} x ${setup}`, async () => {
          const sub = listing(setup, LONG_TERM_LEASE_TERM);
          const accountFee = setup === "account" ? 6000 : null;
          const res = await resolveApplicationFeeProperty(
            dbFor(sub, accountFee),
            {
              propertyId: PID,
              managerUserId: MGR,
              roomChoice1: `${PID}${LISTING_ROOM_CHOICE_SEP}r1`,
              leaseTerm: term || undefined,
              rentalType: "short_term",
              applicationTemplateId: TEMPLATE_ID,
            },
            { allowZeroFee: true },
          );
          if (!res.ok) throw new Error(res.error);
          expect(res.value.applicationFeeCents).toBe(expected(setup, false));
          if (setup !== "nothing") expect(res.value.applicationFeeCents).toBeGreaterThan(0);
        });
      }
    }

    it("listingApplicationFeeRaw: a long-term term beats a short_term rentalType", () => {
      const sub = normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
        applicationFee: "40",
        shortTermApplicationFee: "",
      });
      expect(listingApplicationFeeRaw(sub, "short_term", LONG_TERM_LEASE_TERM)).toBe("40");
      expect(listingApplicationFeeRaw(sub, "short_term", SHORT_TERM_LEASE_TERM)).toBe("");
      // No term (portfolio display range): the rental type stands in.
      expect(listingApplicationFeeRaw(sub, "short_term", null)).toBe("");
    });
  });
});
