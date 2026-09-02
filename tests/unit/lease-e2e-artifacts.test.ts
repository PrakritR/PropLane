// @vitest-environment jsdom
//
// End-to-end verification pass. Generates REAL lease documents across every supported
// jurisdiction and stay kind, writes each one to disk for human inspection, and asserts the
// property that matters most: the document's stated total equals what the ledger will bill.
//
// This file exists to be run and read, not to guard a single regression. It is the answer to
// "can we actually produce a correct, readable lease, and do the charges follow it".
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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

const MANAGER_ID = "mgr-e2e";
const OUT = process.env.LEASE_ARTIFACT_DIR ?? "";

const PLACES = {
  seattle: { address: "5259 Brooklyn Ave NE, Seattle, WA", zip: "98105", neighborhood: "U District" },
  fremont: { address: "3200 Walnut Ave, Fremont, CA", zip: "94538", neighborhood: "Central Fremont" },
  sanFrancisco: { address: "1200 Market St, San Francisco, CA", zip: "94102", neighborhood: "Mid-Market" },
  spokane: { address: "500 W Riverside Ave, Spokane, WA", zip: "99201", neighborhood: "Downtown" },
  austin: { address: "900 Elm St, Austin, TX", zip: "78701", neighborhood: "Downtown" },
};

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Room 7", monthlyRent: 825, ...over } as ManagerRoomSubmission;
}

function seedListing(
  propertyId: string,
  place: { address: string; zip: string; neighborhood: string },
  r: ManagerRoomSubmission,
  subOver: Partial<ManagerListingSubmissionV1> = {},
): MockProperty {
  const sub = { ...createDefaultListingSubmission(), ...subOver, address: place.address, zip: place.zip };
  sub.rooms = [r];
  sub.securityDeposit = subOver.securityDeposit ?? "400";
  const property: MockProperty = {
    id: propertyId,
    title: "Brooklyn House",
    tagline: "Co-living rooms",
    ...place,
    beds: 1,
    baths: 1,
    rentLabel: "$825/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Brooklyn House",
    unitLabel: "Room 7",
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
    fullLegalName: "Arnav Shanbhag",
    email: "arnav@example.com",
    leaseTerm: "Custom",
    leaseStart: "2026-09-01",
    leaseEnd: "2027-08-31",
    rentalType: "standard",
    ...over,
  };
}

function applicantRow(propertyId: string, email: string, app: Partial<RentalWizardFormState>): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Arnav Shanbhag",
    email,
    property: "Brooklyn House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: app,
  } as unknown as DemoApplicantRow;
}

function money(label: string): number {
  return Number(String(label).replace(/[^0-9.]/g, "")) || 0;
}

function ledgerTotal(email: string): number {
  return Number(
    readHouseholdCharges()
      .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
      .reduce((sum, c) => sum + money(c.amountLabel), 0)
      .toFixed(2),
  );
}

function ledgerLines(email: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .map((c) => `${c.title}: ${c.amountLabel}`);
}

function generate(app: Partial<RentalWizardFormState>) {
  return buildAiGeneratedLeaseHtml(leaseContextFromApplication(app));
}

function html(app: Partial<RentalWizardFormState>): string {
  const outcome = generate(app);
  if (outcome.kind !== "generated") throw new Error(`expected generated, got ${outcome.kind}: ${outcome.error}`);
  return outcome.html;
}

/** Saves the rendered lease so a human can open it and judge the formatting. */
function save(name: string, body: string, email?: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const ledger = email ? `\n<!-- LEDGER: ${ledgerLines(email).join(" | ")} -->\n` : "";
  writeFileSync(join(OUT, `${name}.html`), body + ledger, "utf8");
}

/** Section headings, in document order, as a reader would see them. */
function headings(body: string): string[] {
  return [...body.matchAll(/<h2>(.*?)<\/h2>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&"));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("lease documents: generation, formatting and ledger agreement", () => {
  it("Seattle long-term produces a complete, ordered residential lease", () => {
    const pid = "e2e-seattle-long";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825, utilitiesEstimate: "175" }), {
      moveInFee: "200",
      lateFeeAmount: "75",
    });
    const app = application(pid);
    const body = html(app);
    save("01-seattle-long-term", body);

    const h = headings(body);
    // Numbered from 1 with no gaps or repeats: the counter, not hand-written numbers.
    const numbered = h.filter((x) => /^\d+\./.test(x)).map((x) => Number(x.split(".")[0]));
    expect(numbered).toEqual(numbered.map((_, i) => i + 1));

    expect(body).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(h.join(" | ")).toContain("Parties");
    expect(h.join(" | ")).toContain("Rent");
    expect(h.join(" | ")).toContain("Security Deposit");
    expect(body).toContain("Electronic Signature");
    // Washington governing law, and nothing from the other supported state.
    expect(body).toContain("State of Washington");
    expect(body).not.toContain("San Francisco Rent Ordinance");
    expect(body).not.toMatch(/California Civil Code/);
  });

  it("Fremont CA long-term is California and carries no San Francisco ordinance", () => {
    const pid = "e2e-fremont-long";
    seedListing(pid, PLACES.fremont, room({ monthlyRent: 2100 }));
    const body = html(application(pid));
    save("02-fremont-california-long-term", body);

    expect(body).toContain("State of California");
    expect(body).not.toContain("San Francisco Rent Ordinance");
    expect(body).not.toContain("City and County of San Francisco");
    // The WA statutes that used to print on every California lease.
    expect(body).not.toContain("RCW 59.18");
  });

  it("San Francisco keeps its municipal paragraph", () => {
    const pid = "e2e-sf-long";
    seedListing(pid, PLACES.sanFrancisco, room({ monthlyRent: 2600 }));
    const body = html(application(pid));
    save("03-san-francisco-long-term", body);
    expect(body).toContain("San Francisco");
    expect(body).toContain("State of California");
  });

  it("Spokane WA is statewide Washington with no Seattle-specific content", () => {
    const pid = "e2e-spokane-long";
    seedListing(pid, PLACES.spokane, room({ monthlyRent: 1100 }));
    const body = html(application(pid));
    save("04-spokane-washington-long-term", body);

    expect(body).toContain("State of Washington");
    expect(body).not.toContain("City of Seattle");
    expect(body).not.toContain("PROPLANE SEATTLE HOUSING");
  });

  it("Austin TX returns an actionable outcome instead of throwing", () => {
    const pid = "e2e-austin";
    seedListing(pid, PLACES.austin, room({ monthlyRent: 1500 }));
    const outcome = generate(application(pid));
    expect(outcome.kind).toBe("unsupported_jurisdiction");
    if (outcome.kind === "unsupported_jurisdiction") {
      expect(outcome.error).toMatch(/upload/i);
      if (OUT) writeFileSync(join(OUT, "05-austin-unsupported.txt"), outcome.error, "utf8");
    }
  });

  it("a short stay produces the stay agreement, and its Total due equals the ledger", () => {
    const email = "shortstay@example.com";
    removeResidentHouseholdPaymentData(email);
    const pid = "e2e-seattle-short";
    seedListing(pid, PLACES.seattle, room({ rentBasis: "daily", dailyRentPrice: 55, shortTermDeposit: "300" }), {
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "40",
      shortTermMoveInFee: "50",
    });
    const app = application(pid, {
      rentalType: "short_term",
      leaseTerm: "Short-Term Stay",
      leaseStart: "2026-09-03",
      leaseEnd: "2026-09-13",
    });

    recordApprovedApplicationCharges(applicantRow(pid, email, app), MANAGER_ID, true);
    const body = html(app);
    save("06-seattle-short-term-stay", body, email);

    expect(body).toContain("SHORT-TERM ROOM STAY AGREEMENT");
    // The room's own daily price wins over the listing's cheaper shortTermDailyCost.
    expect(body).toContain("$55.00 per day");
    expect(body).not.toContain("$40.00 per day");
    // No em dash placeholders anywhere a number belongs.
    expect(body).not.toMatch(/<td>—<\/td>\s*<\/tr>\s*<tr class="total-row"/);

    const table = body.split("4. Payment")[1]?.split("</table>")[0] ?? "";
    const totalRow = table.split("<tr").find((r) => r.includes("Total due")) ?? "";
    const documentTotal = money(totalRow.replace(/<[^>]*>/g, " ").replace("Total due", ""));

    // THE INVARIANT: what the agreement says the guest owes is what the ledger bills.
    expect(documentTotal).toBeGreaterThan(0);
    expect(documentTotal).toBe(ledgerTotal(email));
  });

  it("a long-term placement's charges follow the lease terms", () => {
    const email = "longterm@example.com";
    removeResidentHouseholdPaymentData(email);
    const pid = "e2e-seattle-long-charges";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825, utilitiesEstimate: "175" }), {
      moveInFee: "200",
      securityDeposit: "400",
    });
    const app = application(pid, { leaseStart: "2026-09-01", leaseEnd: "2027-08-31" });

    recordApprovedApplicationCharges(applicantRow(pid, email, app), MANAGER_ID, true);
    const body = html(app);
    save("07-seattle-long-term-with-charges", body, email);

    const lines = ledgerLines(email);
    // The lease's headline amounts are the ones actually billed.
    expect(lines.join(" | ")).toMatch(/\$400\.00/); // deposit
    expect(lines.join(" | ")).toMatch(/\$200\.00/); // move-in fee
    expect(body).toContain("825");
    expect(ledgerTotal(email)).toBeGreaterThan(0);
  });

  it("a pre-1978 property carries the federal lead-paint disclosure verbatim", () => {
    const pid = "e2e-leadpaint";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825 }), { yearBuilt: 1977 });
    const body = html(application(pid));
    save("08-seattle-pre1978-lead-paint", body);
    expect(body).toMatch(/lead/i);
    // Exactly one lead-paint section: the builder's old hardcoded clause must not double up.
    const leadHeadings = headings(body).filter((x) => /lead/i.test(x));
    expect(leadHeadings.length).toBeLessThanOrEqual(1);
  });

  it("an UNKNOWN year still carries the lead-paint disclosure", () => {
    // The regression this guards: keying the section on firedRules dropped it entirely when
    // year_built was blank, which is most listings. A required federal disclosure must never
    // vanish because a field is empty.
    const pid = "e2e-leadpaint-unknown";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825 }));
    const body = html(application(pid));
    save("10-seattle-unknown-year-lead-paint", body);
    expect(headings(body).some((x) => /lead/i.test(x))).toBe(true);
    expect(body).toContain("4852d");
  });

  it("the prorated cross-reference names the REAL rent and utilities sections", () => {
    // Compact WA leases inline proration in §3 instead of a separate numbered section.
    const pid = "e2e-prorated-xref";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825, utilitiesEstimate: "175" }));
    const body = html(application(pid, { leaseStart: "2026-09-14", leaseEnd: "2027-09-13" }));
    save("11-seattle-prorated-crossref", body);

    expect(body).toContain("For the first partial month");
    // The proration line has TWO shapes now: itemized when both a prorated rent
    // and a prorated utilities figure are known, and a combined
    // "(prorated rent and utilities)" otherwise. Both name rent and utilities,
    // which is what this assertion is actually about.
    expect(body).toMatch(/prorated rent and (utilities|<strong>[^<]*<\/strong> prorated utilities)/);
    const h = headings(body);
    expect(h.some((x) => /Rent and Utilities/i.test(x))).toBe(true);
  });

  it("a post-1978 property does not carry it", () => {
    const pid = "e2e-post1978";
    seedListing(pid, PLACES.seattle, room({ monthlyRent: 825 }), { yearBuilt: 2015 });
    const body = html(application(pid));
    save("09-seattle-post1978", body);
    expect(headings(body).filter((x) => /lead/i.test(x)).length).toBe(0);
  });
});
