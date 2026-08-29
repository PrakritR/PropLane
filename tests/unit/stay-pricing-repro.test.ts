/**
 * @vitest-environment jsdom
 *
 * The stay-pricing bug, end to end: for one fixture, the lease DOCUMENT and the
 * charge LEDGER must quote the same rate.
 *
 * Both sides are driven here on purpose. `recordApprovedApplicationCharges` is what
 * the manager portal runs on approval, and `buildAiGeneratedLeaseHtml` is what the
 * Leases pipeline runs on generate; before the stay-pricing resolver they read two
 * different "daily rate" fields and disagreed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensurePendingHoldingDepositCharge,
  markHoldingDepositPaidAfterStripe,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { buildAiGeneratedLeaseHtml, leaseContextFromApplication } from "@/lib/generated-lease";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const MANAGER_ID = "mgr-stay-pricing";

/** Fremont is the reported case: California, but not San Francisco. */
const FREMONT = { address: "3200 Walnut Ave, Fremont, CA", zip: "94538", neighborhood: "Central Fremont" };

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Room 1", monthlyRent: 1200, ...over } as ManagerRoomSubmission;
}

function seedListing(
  propertyId: string,
  r: ManagerRoomSubmission,
  subOver: Partial<ManagerListingSubmissionV1> = {},
): MockProperty {
  const sub = { ...createDefaultListingSubmission(), ...subOver };
  sub.rooms = [r];
  sub.securityDeposit = subOver.securityDeposit ?? "900";
  const property: MockProperty = {
    id: propertyId,
    title: "Walnut Ave House",
    tagline: "Rooms by the day",
    ...FREMONT,
    beds: 1,
    baths: 1,
    rentLabel: "$55/day",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Walnut Ave House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function application(propertyId: string, over: Partial<RentalWizardFormState> = {}): Partial<RentalWizardFormState> {
  return {
    propertyId,
    roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    fullLegalName: "Dana Tenant",
    email: "dana@example.com",
    leaseTerm: "Custom",
    leaseStart: "2026-03-10",
    leaseEnd: "2026-03-20",
    rentalType: "standard",
    ...over,
  };
}

function applicantRow(propertyId: string, email: string, app: Partial<RentalWizardFormState>): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Walnut Ave House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: app,
  } as unknown as DemoApplicantRow;
}

/** Every rent-ish charge for this resident (daily rooms bill "rent", short stays bill "stay_total"). */
function rentCharges(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .filter((c) => c.kind.includes("rent") || c.kind === "stay_total")
    .map((c) => ({ title: c.title, amount: c.amountLabel }));
}

function money(label: string): number {
  return Number(String(label).replace(/[^0-9.]/g, "")) || 0;
}

/** Everything the ledger will bill this resident, summed. */
function ledgerTotal(email: string): number {
  return Number(
    readHouseholdCharges()
      .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
      .reduce((sum, c) => sum + money(c.amountLabel), 0)
      .toFixed(2),
  );
}

/** The "Total due" the short-stay agreement states. */
function documentTotalDue(html: string): number {
  const table = html.split("<h2>4. Payment</h2>")[1]?.split("</table>")[0] ?? "";
  const row = table.split("<tr").find((r) => r.includes("Total due")) ?? "";
  return money(row.replace(/<[^>]*>/g, " ").replace("Total due", ""));
}

function leaseHtml(app: Partial<RentalWizardFormState>): string {
  const outcome = buildAiGeneratedLeaseHtml(leaseContextFromApplication(app));
  if (outcome.kind !== "generated") throw new Error(outcome.error);
  return outcome.html;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("stay pricing: document and ledger agree", () => {
  it("1. daily-priced room with short-term rentals TICKED gets the short-term stay agreement", () => {
    const email = "ticked@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-ticked";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
    });
    const app = application(propertyId);

    // Mar 10 → Mar 20 2026 is an 11-day stay: 11 × $55 = $605.
    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);
    expect(rentCharges(email)[0]?.amount).toBe("$605.00");

    const html = leaseHtml(app);
    expect(html).toContain("SHORT-TERM ROOM STAY AGREEMENT (11-Day Stay)");
    expect(html).toContain("$55.00 per day");
    expect(html).toContain("$605.00");
  });

  it("1b. the SAME stay on a listing that never offered short stays gets the residential lease at the daily rate", () => {
    // The lodger agreement asserts an owner-occupied residence and disclaims tenancy. A
    // billing-basis flag plus two dates does not establish that, so it needs the manager's
    // own "short-term rentals allowed" declaration. The charges are identical either way.
    const email = "untick@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-untick";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: false,
    });
    const app = application(propertyId);

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);
    expect(rentCharges(email)[0]?.amount).toBe("$605.00");

    const html = leaseHtml(app);
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).not.toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(html).toContain("Lead-Based Paint Disclosure");
    // The rate the ledger bills, under a label that says "day".
    expect(html).toContain("$55.00 / day");
    expect(html).toContain("Daily base rent");
    expect(html).not.toContain("Monthly base rent");
  });

  it("2. room daily price beats the listing shortTermDailyCost on BOTH sides", () => {
    const email = "conflict@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-conflict";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "40",
      shortTermDeposit: "300",
    });
    const app = application(propertyId, { rentalType: "short_term", leaseTerm: "Short-Term Stay" });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);
    // An EXPLICIT short-term stay bills checkout-exclusive nights: Mar 10 to Mar 20 is 10
    // nights, not 11 days. A daily-basis tenancy on a standard application still bills the
    // inclusive 11 (see the tests below), which is why the two counts differ.
    expect(rentCharges(email)[0]?.amount).toBe("$550.00");

    const html = leaseHtml(app);
    expect(html).toContain("$55.00 per day");
    expect(html).not.toContain("$40.00 per day");
    // Same 10 nights the ledger just billed. Document and ledger agree, which is the point.
    expect(html).toContain("$550.00");
  });

  it("3. blank listing short-term fields render no em-dash when the room carries a daily price", () => {
    const email = "blank@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-blank";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "",
      shortTermDeposit: "",
    });
    const app = application(propertyId, { rentalType: "short_term", leaseTerm: "Short-Term Stay" });

    const html = leaseHtml(app);
    expect(html).toContain("$55.00 per day");
    expect(html).not.toContain("— per day");
  });

  it("4. a negotiated monthly rent still beats the room's daily basis", () => {
    const email = "override@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-override";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }));
    const app = application(propertyId, { managerRentOverride: "1500" });

    const html = leaseHtml(app);
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).toContain("$1,500.00");
    expect(html).not.toContain("SHORT-TERM ROOM STAY AGREEMENT");
  });

  it("5. REGRESSION: a monthly room is untouched", () => {
    const email = "monthly@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-monthly";
    seedListing(propertyId, room({ monthlyRent: 1200 }));
    const app = application(propertyId);

    const html = leaseHtml(app);
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).toContain("$1200.00 / month");
    expect(html).not.toContain("SHORT-TERM ROOM STAY AGREEMENT");
  });

  it("6. uploaded-template rider labels a daily rate as daily, not Monthly rent", () => {
    const propertyId = "prop-stay-template";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
      leaseTemplateDocUrl: "/api/portal/lease-template?path=11111111-1111-1111-1111-111111111111/lease-template.pdf",
      leaseTemplateDocName: "House lease.pdf",
    });

    const html = leaseHtml(application(propertyId));
    expect(html).toContain("<th>Daily rate</th>");
    expect(html).not.toContain("<th>Monthly rent</th>");
  });

  it("9. THE INVARIANT: the stay agreement's Total due equals every charge the ledger writes", () => {
    // This is the whole point of the resolver. The document quoted rent + deposit only, while
    // the ledger also billed prorated utilities and a move-in fee.
    //
    // The stay is placed in a FUTURE month on purpose, computed from the clock rather than
    // hardcoded so it stays future forever: the recurring generator only looks forward, so a
    // past-dated stay silently skips the double-billing path this pins.
    const email = "total@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-total";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55, utilitiesEstimate: "120" }), {
      shortTermRentalsAllowed: true,
      securityDeposit: "900",
      moveInFee: "300",
      applicationFee: "",
    });

    // A 31-day month two months out, days 3..13 → an 11-day stay.
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    const app = application(propertyId, { leaseStart: `${ym}-03`, leaseEnd: `${ym}-13` });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);

    const expectedUtilities = Number((120 * (11 / daysInMonth)).toFixed(2));
    const expected = Number((11 * 55 + expectedUtilities + 900 + 300).toFixed(2));
    expect(documentTotalDue(leaseHtml(app))).toBe(ledgerTotal(email));
    expect(documentTotalDue(leaseHtml(app))).toBe(expected);
  });

  it("10. a future-dated lease is not billed twice for its move-in month", () => {
    // Regression: the recurring generator always looked one month ahead, even when that month
    // was BEFORE the profile's start month. A profile deliberately starts the month AFTER
    // move-in because the move-in month is already covered by the upfront charges, so for any
    // lease starting in a future month the same month was billed twice. Monthly rooms too.
    const email = "double@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-double";
    seedListing(propertyId, room({ monthlyRent: 1200 }), { applicationFee: "" });

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    const app = application(propertyId, { leaseStart: `${ym}-03`, leaseEnd: `${ym}-13` });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);

    // The upfront prorated first/last-month charges are the legacy monthly path and stay.
    // What must NOT exist is a recurring "rent" row for the move-in month, which the profile
    // deliberately does not cover.
    const recurring = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email && (c.kind === "rent" || c.kind === "utilities"),
    );
    expect(recurring.map((c) => `${c.kind} ${c.rentMonth}`)).toEqual([]);
  });

  it("8. a multi-month daily-priced tenancy keeps the full residential lease", () => {
    const email = "longdaily@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-longdaily";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }));
    // Mar 10 -> Jun 12: the ledger bills four recurring monthly rent charges, so the guest
    // must NOT receive a lodger agreement stating one up-front stay total.
    const app = application(propertyId, { leaseStart: "2026-03-10", leaseEnd: "2026-06-12" });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);
    expect(rentCharges(email).length).toBeGreaterThan(1);

    const html = leaseHtml(app);
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).not.toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(html).not.toContain("Lodger Status");
    // The federally required disclosure that the short-term document does not carry.
    expect(html).toContain("Lead-Based Paint Disclosure");

    // The long form must quote the rate the ledger actually bills, under a label that says
    // "day", and must NOT invent a monthly total by adding a day rate to monthly utilities.
    expect(html).toContain("$55.00 / day");
    expect(html).toContain("Daily base rent");
    expect(html).not.toContain("Monthly base rent");
    expect(html).not.toContain("Total monthly payment");
    expect(html).not.toContain("$1200.00 / month");
    // 30 is the display-only monthly estimate; it must never reach a lease.
    expect(html).not.toContain("$1,650.00");
    // Prorating a monthly rent is nonsense when every month bills by real days.
    expect(html).not.toContain("Prorated First Month");
  });

  it("11. the stay total uses the room's DAILY utilities rate when it has one", () => {
    // rentBasis "daily" and prorateMethod "daily_rate" are independent fields that coexist.
    // The ledger prorates utilities at dailyUtilitiesRate × days, so the document must too.
    const email = "dailyutils@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-dailyutils";
    seedListing(
      propertyId,
      room({
        rentBasis: "daily",
        dailyRentPrice: 55,
        utilitiesEstimate: "120",
        prorateMethod: "daily_rate",
        dailyUtilitiesRate: 6,
      }),
      { shortTermRentalsAllowed: true, securityDeposit: "900", moveInFee: "300", applicationFee: "" },
    );

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const ym = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    const app = application(propertyId, { leaseStart: `${ym}-03`, leaseEnd: `${ym}-13` });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);

    // 11 days × $6/day = $66.00, NOT the flat 120 × (11/daysInMonth).
    const expected = Number((11 * 55 + 11 * 6 + 900 + 300).toFixed(2));
    expect(documentTotalDue(leaseHtml(app))).toBe(ledgerTotal(email));
    expect(documentTotalDue(leaseHtml(app))).toBe(expected);
  });

  it("12. the deposit the document states is the OBLIGATION, unmoved by a holding-deposit payment", () => {
    // The document is generated once and cannot be rebuilt after it carries a signature, while
    // the holding deposit can be paid on either side of that moment. Quoting the resident's
    // running net would therefore be permanently wrong in one direction or the other, so the
    // lease states the fixed obligation and points at the ledger for the balance.
    const email = "holding@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-holding";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
      securityDeposit: "900",
      holdingDeposit: "250",
      moveInFee: "",
      applicationFee: "",
    });
    const app = application(propertyId);
    const row = applicantRow(propertyId, email, app);

    const before = leaseHtml(app);
    expect(before).toContain("$900.00");
    expect(before).toContain("credited against the security deposit");
    expect(documentTotalDue(before)).toBe(605 + 900);

    ensurePendingHoldingDepositCharge({
      residentEmail: email,
      residentName: "Dana Tenant",
      residentUserId: null,
      propertyId,
      applicationId: row.id,
      managerUserId: MANAGER_ID,
    });
    markHoldingDepositPaidAfterStripe(email, propertyId, null);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    // The ledger — the authority for the balance — nets the credit off.
    const securityCharge = readHouseholdCharges().find(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "security_deposit",
    );
    expect(securityCharge?.amountLabel).toBe("$650.00");

    // The document does not move: same deposit, same total, same standing sentence.
    const after = leaseHtml(app);
    expect(after.replace(/Generated [^<]*/, "")).toBe(before.replace(/Generated [^<]*/, ""));
    expect(documentTotalDue(after)).toBe(605 + 900);
  });

  it("13. the residential lease carries the same holding-deposit credit sentence", () => {
    const propertyId = "prop-stay-holding-long";
    seedListing(propertyId, room({ monthlyRent: 1200 }), {
      securityDeposit: "900",
      moveInFee: "",
      applicationFee: "",
    });

    const html = leaseHtml(application(propertyId));
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).toContain("credited against the security deposit");
    expect(html).not.toContain("Less holding deposit paid");
  });

  it("14. a non-ISO intra-month lease collapses to ONE charge, like its ISO twin", () => {
    // The ledger used to split lease dates strictly on "-", so a manually added resident whose
    // move-in/out dates are not ISO fell out of the intra-month collapse and was billed a
    // first-month AND a last-month charge for the same days. Both sides now parse the same way.
    const email = "nonisodates@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-noniso";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
    });

    const row = {
      ...applicantRow(propertyId, email, application(propertyId, { leaseStart: "", leaseEnd: "" })),
      manualResidentDetails: { moveInDate: "3/10/2026", moveOutDate: "3/20/2026" },
    } as unknown as DemoApplicantRow;

    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    const charges = rentCharges(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amount).toBe("$605.00");
  });

  it("15. a daily-basis long lease discloses the SAME prorated first-month utilities the ledger bills", () => {
    // Rent needs no proration on a daily basis, but utilities are still a monthly estimate and
    // the ledger still prorates them. Suppressing the whole section left that undisclosed.
    const email = "dailylongutils@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-dailylongutils";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55, utilitiesEstimate: "200" }), {
      shortTermRentalsAllowed: false,
      applicationFee: "",
    });
    const app = application(propertyId, { leaseStart: "2026-03-10", leaseEnd: "2026-06-30" });

    recordApprovedApplicationCharges(applicantRow(propertyId, email, app), MANAGER_ID, true);
    const proratedUtilities = readHouseholdCharges().find(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "prorated_utilities",
    );
    // $200 × 22/31 days from a Mar 10 start.
    expect(proratedUtilities?.amountLabel).toBe("$141.94");

    const html = leaseHtml(app);
    expect(html).toContain("RESIDENTIAL ROOM RENTAL AGREEMENT");
    expect(html).toContain("Prorated Utilities");
    expect(html).toContain("$141.94");
    // Rent is never prorated on a daily basis; only the utilities half of the section renders.
    expect(html).not.toContain("Prorated First Month");
    expect(html).not.toContain("Prorated total due first month");
    // The Section 4 prose must not assert the full monthly estimate applies to a partial month.
    expect(html).toContain("prorated for any partial month");
  });

  it("16. document and ledger resolve the SAME room when a signed rent and a unit label disagree", () => {
    // roomChoice1 carries no listingRoomId (legacy / manual assignment). The property's unit
    // label matches room A, the signed rent exactly matches room B. An exact figure outranks a
    // fuzzy label, and both sides feed the shared chain the same inputs — so both pick B.
    const email = "tworooms@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-stay-tworooms";

    const sub = { ...createDefaultListingSubmission() };
    sub.rooms = [
      room({ id: "room-a", name: "Unit 2", monthlyRent: 0, rentBasis: "daily", dailyRentPrice: 55, prorateMethod: "daily_rate", dailyRentRate: 90 }),
      room({ id: "room-b", name: "Unit 7", monthlyRent: 1200 }),
    ];
    sub.securityDeposit = "900";
    sub.applicationFee = "";
    cachePublicExtraListings(
      [
        {
          id: propertyId,
          title: "Walnut Ave House",
          tagline: "Two rooms",
          ...FREMONT,
          beds: 2,
          baths: 1,
          rentLabel: "$1200/mo",
          available: "Now",
          petFriendly: false,
          buildingId: "b1",
          buildingName: "Walnut Ave House",
          unitLabel: "Unit 2",
          adminPublishLive: true,
          managerUserId: MANAGER_ID,
          listingSubmission: normalizeManagerListingSubmissionV1(sub),
        } as MockProperty,
      ],
      { silent: true },
    );

    // No listingRoomId on either choice, and both sides know the signed rent.
    const app = {
      ...application(propertyId, { leaseStart: "2026-03-10", leaseEnd: "2026-08-31" }),
      roomChoice1: propertyId,
      __signedRentLabel: "$1,200.00 / month",
    } as Partial<RentalWizardFormState>;
    const row = {
      ...applicantRow(propertyId, email, app),
      assignedRoomChoice: propertyId,
      signedMonthlyRent: 1200,
    } as DemoApplicantRow;

    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    // Room B's monthly proration, NOT room A's $90/day proration rate (which would be $1,980).
    expect(rentCharges(email).map((c) => c.amount)).toContain("$851.61");
    expect(rentCharges(email).map((c) => c.amount)).not.toContain("$1980.00");

    const html = leaseHtml(app);
    expect(html).toContain("$851.61");
    expect(html).not.toContain("$1,980.00");
    expect(html).not.toContain("/day");
  });

  it("7. a California property outside San Francisco does not claim San Francisco", () => {
    const propertyId = "prop-stay-fremont";
    seedListing(propertyId, room({ monthlyRent: 1200 }));

    const html = leaseHtml(application(propertyId));
    expect(html).toContain("State of California");
    expect(html).not.toContain("City and County of San Francisco");
    expect(html).not.toContain("San Francisco Rent Ordinance");
  });
});

describe("stay pricing: the document never asserts a credit the ledger will not apply", () => {
  it("omits the holding-deposit credit note on an EXPLICIT short-term agreement", () => {
    // The ledger credits a paid holding deposit only on its standard branch; the short-term
    // branch charges the full shortTermDeposit and returns before that code. Printing the
    // note there tells a guest they get a credit that is never applied.
    const propertyId = "prop-credit-short";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
      shortTermDeposit: "300",
    });
    const html = leaseHtml(
      application(propertyId, { rentalType: "short_term", leaseTerm: "Short-Term Stay" }),
    );
    expect(html).toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(html).not.toContain("holding deposit already paid");
  });

  it("keeps the note when the stay document backs a STANDARD application, which the ledger does credit", () => {
    const propertyId = "prop-credit-standard";
    seedListing(propertyId, room({ rentBasis: "daily", dailyRentPrice: 55 }), {
      shortTermRentalsAllowed: true,
      securityDeposit: "900",
    });
    const html = leaseHtml(application(propertyId));
    expect(html).toContain("SHORT-TERM ROOM STAY AGREEMENT");
    expect(html).toContain("holding deposit already paid");
  });
});

describe("stay pricing: statewide leases do not carry another state's numeric terms", () => {
  it("a California lease states no Washington notice period, deposit window, or heat figure", () => {
    const propertyId = "prop-ca-terms";
    seedListing(propertyId, room({ monthlyRent: 1200 }));
    const html = leaseHtml(application(propertyId, { leaseTerm: "12-Month", leaseEnd: "2027-03-09" }));
    expect(html).toContain("State of California");
    expect(html).not.toContain("20 days before the end of any monthly rental period");
    expect(html).not.toContain("Within 30 days after termination");
    expect(html).not.toContain("68°F");
    // Replaced by language that asserts no specific figure rather than a guessed one.
    expect(html).toContain("required by applicable law");
  });

  it("a Washington lease KEEPS its own verified figures", () => {
    // The California fix must not strip the terms from the state they actually came from.
    const propertyId = "prop-wa-terms";
    const property = seedListing(propertyId, room({ monthlyRent: 1200 }));
    cachePublicExtraListings(
      [{ ...property, address: "1500 Pike St, Seattle, WA", zip: "98101", neighborhood: "Belltown" }],
      { silent: true },
    );
    const html = leaseHtml(application(propertyId, { leaseTerm: "12-Month", leaseEnd: "2027-03-09" }));
    expect(html).toContain("State of Washington");
    expect(html).toContain("Within 30 days after termination");
    expect(html).toContain("68°F");
    // The month-to-month termination notice is NOT among them any more: a
    // fixed-term lease no longer converts to a month-to-month tenancy, so the
    // notice period that governed that conversion has nothing left to govern.
    // Asserting it here would demand a clause the document deliberately dropped.
    expect(html).toContain("does not convert to a month-to-month tenancy");
    expect(html).not.toContain("20 days before the end of any monthly rental period");
  });

  it("a Washington MONTH-TO-MONTH lease states its termination notice period", () => {
    // The notice governs an ongoing month-to-month tenancy, so the tenancy that
    // still has one must print it — a month-to-month lease silent about how it
    // may be ended is worse than either wording.
    const propertyId = "prop-wa-mtm";
    const property = seedListing(propertyId, room({ monthlyRent: 1200 }));
    cachePublicExtraListings(
      [{ ...property, address: "1500 Pike St, Seattle, WA", zip: "98101", neighborhood: "Belltown" }],
      { silent: true },
    );
    const html = leaseHtml(application(propertyId, { leaseTerm: "Month-to-Month", leaseEnd: "" }));
    expect(html).toContain("State of Washington");
    expect(html).toContain("at least 20 days before the end of any monthly rental period");
  });

  it("a California MONTH-TO-MONTH lease asserts no unsourced notice period", () => {
    const propertyId = "prop-ca-mtm";
    seedListing(propertyId, room({ monthlyRent: 1200 }));
    const html = leaseHtml(application(propertyId, { leaseTerm: "Month-to-Month", leaseEnd: "" }));
    expect(html).toContain("State of California");
    expect(html).not.toContain("20 days before the end of any monthly rental period");
    expect(html).toContain("written notice to terminate within the period required by applicable law");
  });
});
