/**
 * @vitest-environment jsdom
 *
 * Short term runs inside the resident portal with the same application -> lease ->
 * payments process as long term (captain, Oct 3): the listing's two apply doors, the
 * short-term application + lease templates, `resolveStayPricing` as the one price decision,
 * the stage unlock a short-term applicant gets, and the charges a short stay creates.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { listingTermCtas } from "@/lib/listing-prospect-cta-labels";
import { buildProspectApplyHref } from "@/lib/prospect-public-nav";
import {
  HOUSEHOLD_CHARGES_SESSION_KEY,
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
import { resolveStayPricing } from "@/lib/room-pricing";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import {
  SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS,
  STANDARD_APPLICATION_FIELD_CATALOG,
} from "@/lib/rental-application/application-field-catalog";
import { createPropertyApplicationTemplate, type ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { resolvePropertyLeaseTemplateForApplication } from "@/lib/property-lease-template-sync";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import {
  isResidentPathAllowedForAccess,
  resolveResidentPortalNavStage,
  residentBottomNavPrimarySections,
  residentSectionUnlockedForStage,
} from "@/lib/resident-portal-nav";
import {
  countByResidentTerm,
  defaultResidentTerm,
  parseResidentTermParam,
  residentHasShortTermRecords,
  residentTermByApplicationId,
  residentTermOfCharge,
  residentTermOfRecord,
} from "@/lib/resident-term-split";
import { targetMatchesApplication } from "@/lib/rental-application/in-progress-application";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

describe("listing apply doors", () => {
  it("offers Apply long term, and Apply short term only when the listing offers short stays", () => {
    expect(listingTermCtas({ shortStayOffered: false }).map((c) => c.label)).toEqual(["Apply long term"]);
    expect(listingTermCtas({ shortStayOffered: true }).map((c) => c.label)).toEqual([
      "Apply long term",
      "Apply short term",
    ]);
  });

  it("keeps the lease-first wording for both terms", () => {
    expect(listingTermCtas({ shortStayOffered: true, signingOrder: "lease_first" }).map((c) => c.label)).toEqual([
      "Sign lease long term",
      "Sign lease short term",
    ]);
  });

  it("only the short door selects the short-term application", () => {
    const [long, short] = listingTermCtas({ shortStayOffered: true });
    expect(long!.rentalType).toBe("standard");
    expect(short!.rentalType).toBe("short_term");
  });

  it("the short door opens the in-portal application for a signed-in resident, and the public one otherwise", () => {
    const signedIn = { ready: true, userId: "u1", hasResidentRole: true };
    const signedOut = { ready: true, userId: null, hasResidentRole: false };
    const params = { propertyId: "p1", rentalType: "short_term" as const };
    expect(buildProspectApplyHref(params, signedIn)).toBe("/resident/applications/apply?propertyId=p1&rentalType=short_term");
    expect(buildProspectApplyHref(params, signedOut)).toBe("/rent/apply?propertyId=p1&rentalType=short_term");
    expect(buildProspectApplyHref({ propertyId: "p1" }, signedIn)).toBe("/resident/applications/apply?propertyId=p1");
  });

  it("the listing card has no second booking flow", () => {
    const source = readFileSync("src/components/marketing/listing-detail-sections.tsx", "utf8");
    expect(source).not.toContain("Book a short stay");
    expect(source).not.toContain("/rent/stay");
    expect(source).toContain("listingTermCtas");
    const stay = readFileSync("src/app/(public)/rent/stay/page.tsx", "utf8");
    expect(stay).toContain("redirect(");
    expect(stay).toContain('rentalType: "short_term"');
  });
});

describe("short-term application and lease templates", () => {
  const published = {
    version: 1,
    disabledStandardApplicationKeys: [],
    customApplicationFields: [],
    applicationConfigMode: "standard",
  } as unknown as ApplicationTemplateQuestionConfig;

  it("the default short-term application drops employment, income, references and screening questions", () => {
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    const short = applicationConfigForApplicant(sub, "short_term").config;
    const long = applicationConfigForApplicant(sub, "standard").config;
    const employment = STANDARD_APPLICATION_FIELD_CATALOG.filter((d) => d.section === "employment").map((d) => d.standardKey);
    expect(employment.length).toBeGreaterThan(0);
    for (const key of employment) {
      expect(short.disabledStandardApplicationKeys).toContain(key);
      expect(long.disabledStandardApplicationKeys).not.toContain(key);
    }
    expect(short.disabledStandardApplicationKeys).toEqual(expect.arrayContaining([...SHORT_TERM_DEFAULT_DISABLED_STANDARD_KEYS]));
  });

  it("a short stay is served the property's published short-term application, not the long-term one", () => {
    const longForm = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    const shortForm = createPropertyApplicationTemplate({ kind: "short-term", label: "Short-term application" });
    const sub = {
      ...createDefaultListingSubmission(),
      propertyApplicationTemplates: [
        { ...longForm, publishedQuestionConfig: published },
        { ...shortForm, formVariant: "short_term" as const, publishedQuestionConfig: published },
      ],
    };
    expect(applicationConfigForApplicant(sub, "short_term").templateId).toBe(shortForm.id);
    expect(applicationConfigForApplicant(sub, "standard").templateId).toBe(longForm.id);
  });

  it("a short stay is served the short-term lease, a long stay the long-term lease", () => {
    const primary = { ...createPropertyLeaseTemplate({ kind: "long-term", label: "Long term lease" }), listingSeedKey: "primary" as const };
    const short = { ...createPropertyLeaseTemplate({ kind: "short-term", label: "Short term lease" }), listingSeedKey: "short-term" as const };
    const sub = { ...createDefaultListingSubmission(), propertyLeaseTemplates: [primary, short] };
    expect(resolvePropertyLeaseTemplateForApplication(sub, { rentalType: "short_term" })?.id).toBe(short.id);
    expect(resolvePropertyLeaseTemplateForApplication(sub, { leaseTerm: "12-Month" })?.id).toBe(primary.id);
  });
});

const MANAGER_ID = "mgr-short-term-flow";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Guest room", monthlyRent: 1200, ...over } as ManagerRoomSubmission;
}

function seedListing(propertyId: string, opts: { deposit?: string; moveIn?: string; utilities?: string } = {}): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "85";
  sub.shortTermMoveInFee = opts.moveIn ?? "";
  sub.applicationFee = "";
  sub.rooms = [room({ monthlyRent: 1200, shortTermDeposit: opts.deposit ?? "", utilitiesEstimate: opts.utilities ?? "150" } as Partial<ManagerRoomSubmission>)];
  sub.allowedLeaseTerms = ["12-Month"];
  const property: MockProperty = {
    id: propertyId,
    title: "Oak Street Guest Room",
    tagline: "Nightly stays welcome",
    address: "100 Oak St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 1,
    baths: 1,
    rentLabel: "$85/night",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Oak Street Guest Room",
    unitLabel: "Guest room",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function shortApplicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Guest Tenant",
    email,
    property: "Oak Street Guest Room",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: "short_term",
      leaseStart: "2026-03-10",
      leaseEnd: "2026-03-16",
      fullLegalName: "Guest Tenant",
    },
  } as unknown as DemoApplicantRow;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
});

describe("short-stay pricing is resolveStayPricing", () => {
  it("prices the stay nightly from the room's dates, never a monthly figure, and the ledger bills the same rate", () => {
    const propertyId = "prop-flow-pricing";
    const listing = seedListing(propertyId);
    const submissionRoom = listing.listingSubmission!.rooms[0]!;
    const application = { rentalType: "short_term" as const, leaseStart: "2026-03-10", leaseEnd: "2026-03-16" };
    const pricing = resolveStayPricing({ room: submissionRoom, submission: listing.listingSubmission!, application });
    expect(pricing.stayKind).toBe("short");
    expect(pricing.basis).toBe("daily");
    expect(pricing.dailyRate).toBe(85);

    const email = "flow-pricing@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(shortApplicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    const stay = readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "stay_total");
    expect(stay?.title).toBe("Stay total (6 nights × $85)");
    expect(stay?.amountLabel).toBe("$510.00");
  });
});

describe("a short stay creates its charges through the approval path", () => {
  it("creates the stay total, short-term move-in fee and deposit under the application, and never utilities", () => {
    const email = "flow-charges@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-flow-charges";
    seedListing(propertyId, { deposit: "100", moveIn: "40" });
    const row = shortApplicant(propertyId, email);

    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });
    const charges = readHouseholdCharges().filter((c) => c.residentEmail === email);

    expect(charges.find((c) => c.kind === "stay_total")?.amountLabel).toBe("$510.00");
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$100.00");
    expect(charges.find((c) => c.kind === "move_in_fee")?.amountLabel).toBe("$40.00");
    expect(charges.some((c) => c.kind === "utilities")).toBe(false);
    // Every charge hangs off the short-term application, so Payments can file it under Short term.
    expect(charges.length).toBeGreaterThanOrEqual(3);
    expect(charges.every((c) => c.applicationId === row.id)).toBe(true);
  });

  it("files those charges under the Short term section of Payments", () => {
    const email = "flow-section@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-flow-section";
    seedListing(propertyId, { deposit: "100", moveIn: "40" });
    const row = shortApplicant(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });
    const charges = readHouseholdCharges().filter((c) => c.residentEmail === email);

    const termById = residentTermByApplicationId([row]);
    expect(charges.every((c) => residentTermOfCharge(c, termById) === "short_term")).toBe(true);
    const counts = countByResidentTerm(charges, (c) => residentTermOfCharge(c, termById));
    expect(counts.long_term).toBe(0);
    expect(counts.short_term).toBe(charges.length);
    expect(residentHasShortTermRecords(counts)).toBe(true);
    expect(defaultResidentTerm(counts)).toBe("short_term");
  });
});

describe("a short-term applicant's portal stages", () => {
  const approvedShortTerm = {
    leaseAccessUnlocked: false,
    applicationApproved: true,
    hasCompletedApplicationSubmission: true,
  };

  it("unlocks Application, Lease and Payments on approval, exactly like a long-term resident", () => {
    const stage = resolveResidentPortalNavStage(approvedShortTerm);
    expect(stage).toBe("post_approval_pre_lease");
    for (const section of ["applications", "lease", "payments", "documents"]) {
      expect(residentSectionUnlockedForStage(section, stage)).toBe(true);
    }
    for (const path of ["/resident/applications", "/resident/lease", "/resident/payments"]) {
      expect(isResidentPathAllowedForAccess(path, approvedShortTerm)).toBe(true);
    }
  });

  it("keeps the bottom bar and the unlock table in agreement at every stage", () => {
    for (const stage of ["pre_approval", "application_submitted", "post_approval_pre_lease", "post_lease"] as const) {
      for (const section of residentBottomNavPrimarySections(stage)) {
        expect(residentSectionUnlockedForStage(section, stage)).toBe(true);
      }
    }
  });

  it("a submitted short-term application still waits for approval before Lease and Payments", () => {
    const submitted = { leaseAccessUnlocked: false, applicationApproved: false, hasCompletedApplicationSubmission: true };
    expect(resolveResidentPortalNavStage(submitted)).toBe("application_submitted");
    expect(isResidentPathAllowedForAccess("/resident/payments", submitted)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/applications", submitted)).toBe(true);
  });
});

describe("the two resident sections", () => {
  it("a record is short term only when its application says so", () => {
    expect(residentTermOfRecord({ application: { rentalType: "short_term" } })).toBe("short_term");
    expect(residentTermOfRecord({ rentalType: "short_term" })).toBe("short_term");
    expect(residentTermOfRecord({ application: { rentalType: "standard" } })).toBe("long_term");
    expect(residentTermOfRecord({})).toBe("long_term");
    expect(residentTermOfRecord(null)).toBe("long_term");
  });

  it("opens on long term unless it is empty and a short stay exists, or a term was asked for", () => {
    expect(defaultResidentTerm({ long_term: 2, short_term: 1 })).toBe("long_term");
    expect(defaultResidentTerm({ long_term: 0, short_term: 1 })).toBe("short_term");
    expect(defaultResidentTerm({ long_term: 0, short_term: 0 })).toBe("long_term");
    expect(defaultResidentTerm({ long_term: 2, short_term: 1 }, "short_term")).toBe("short_term");
    expect(parseResidentTermParam("short")).toBe("short_term");
    expect(parseResidentTermParam("long-term")).toBe("long_term");
    expect(parseResidentTermParam("nope")).toBeUndefined();
  });

  it("a long-term-only resident sees no extra tabs on Lease and Payments", () => {
    expect(residentHasShortTermRecords({ long_term: 3, short_term: 0 })).toBe(false);
  });

  it("a long-term charge and an unknown application stay long term; a stay total is always short", () => {
    const map = residentTermByApplicationId([{ id: "APP-1", application: { rentalType: "standard" } }]);
    expect(residentTermOfCharge({ kind: "rent", applicationId: "app-1" }, map)).toBe("long_term");
    expect(residentTermOfCharge({ kind: "rent", applicationId: "unknown" }, map)).toBe("long_term");
    expect(residentTermOfCharge({ kind: "stay_total" }, map)).toBe("short_term");
  });
});

describe("Apply short term never resumes the long-term draft", () => {
  const longDraft = { propertyId: "p1", rentalType: "standard" as const };
  const shortDraft = { propertyId: "p1", rentalType: "short_term" as const };

  it("matches only the requested term when the request names one", () => {
    expect(targetMatchesApplication({ propertyId: "p1", rentalType: "short_term" }, { application: longDraft })).toBe(false);
    expect(targetMatchesApplication({ propertyId: "p1", rentalType: "short_term" }, { application: shortDraft })).toBe(true);
    expect(targetMatchesApplication({ propertyId: "p1", rentalType: "standard" }, { application: shortDraft })).toBe(false);
    expect(targetMatchesApplication({ propertyId: "p1", rentalType: "standard" }, { application: longDraft })).toBe(true);
  });

  it("a request that names no term matches either, as before", () => {
    expect(targetMatchesApplication({ propertyId: "p1" }, { application: shortDraft })).toBe(true);
    expect(targetMatchesApplication({ propertyId: "p1" }, { application: longDraft })).toBe(true);
  });
});
