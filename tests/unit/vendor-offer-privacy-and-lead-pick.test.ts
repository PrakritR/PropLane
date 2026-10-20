// Review fixes, Oct 20. Two vendor-facing privacy leaks and one irreversible misread:
//  - a job's TITLE (resident- or model-authored) reached the offer text and the vendor-portal board unsanitized,
//    so a street address typed into it went to vendors who had only been OFFERED the job;
//  - a vendor candidate on the PropLane line was labelled with the house (buildingName || address), so the
//    "Is this about A or B?" question and the dedicated-number redirect named the street before acceptance;
//  - a bare leading digit counted as an offer pick, so "2 people" claimed offer 2 and assigned the lead for good.
import { describe, expect, it } from "vitest";
import {
  composeVendorOfferText,
  sanitizeVendorFacingText,
  stripStreetAddresses,
} from "@/lib/vendor-dispatch/text";
import { buildDisambiguationQuestion, spokenLabelFor, VENDOR_PLACE_FALLBACK } from "@/lib/one-number/router.server";
import { propertyGeneralArea, propertyLabel } from "@/lib/one-number/router-lookups.server";
import { parseOfferPick } from "@/lib/one-number/lead-match";
import type { LeadOffer } from "@/lib/one-number/lead-match";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";

const vendor = (over: Partial<SharedLineCandidate>): SharedLineCandidate => ({
  workspaceId: "w2", ownerUserId: "o2", role: "vendor", reason: "vendor_job", propertyId: "p2", label: "", ...over,
});
const resident = (over: Partial<SharedLineCandidate>): SharedLineCandidate => ({
  workspaceId: "w1", ownerUserId: "o1", role: "resident", reason: "resident", propertyId: "p1", label: "", ...over,
});

describe("vendor-facing free text", () => {
  it("strips a street address written in any of the usual shapes", () => {
    expect(stripStreetAddresses("Lockout at 5259 Brooklyn Ave NE")).not.toContain("5259");
    expect(stripStreetAddresses("Leak, 42 S Alder St, Unit 2")).not.toMatch(/Alder/);
    expect(stripStreetAddresses("123 Main Street apt 4B needs a plumber")).not.toMatch(/Main/);
    // A room number or a plain count is not an address.
    expect(stripStreetAddresses("Clean room 3")).toContain("room 3");
    expect(stripStreetAddresses("Fix 2 windows")).toContain("2 windows");
  });

  it("removes the phone, the email and the street in one pass, and tidies what is left", () => {
    const clean = sanitizeVendorFacingText("Lockout at 5259 Brooklyn Ave NE, call Dana (206) 555-0142 or dana@example.com");
    expect(clean).not.toMatch(/5259|Brooklyn/);
    expect(clean).not.toContain("@");
    expect(clean).not.toMatch(/\d{3}[\s.-]?\d{4}/);
    expect(clean.startsWith("Lockout")).toBe(true);
    expect(clean).not.toMatch(/\s{2,}|^[\s,]+|[\s,]+$/);
  });

  // Review fix, Oct 20: the generic pattern needed a type word (St, Ave), so the SUFFIXLESS form this product
  // writes its own houses in survived - and that is the form a resident copies into a request title.
  it("strips a house number with no street-type word, which is how this product names its houses", () => {
    expect(sanitizeVendorFacingText("Leak at 5259 Brooklyn")).toBe("Leak");
    expect(sanitizeVendorFacingText("Lockout 4709A 8th")).toBe("Lockout");
    expect(sanitizeVendorFacingText("412 Pine needs a plumber")).toBe("needs a plumber");
    expect(sanitizeVendorFacingText("Clean 4100 NE 45th unit")).toBe("Clean unit");
  });

  it("leaves counts and measurements alone: they are not addresses", () => {
    for (const text of ["Fix 3 windows", "2 people", "100 feet of pipe", "Clean room 3", "Replace 12 bulbs"]) {
      expect(sanitizeVendorFacingText(text)).toBe(text);
    }
  });

  // Review fix, Oct 20. The pattern matched a 3-6 digit number plus Title-Case words, which is also exactly how a
  // trade job title writes an equipment spec - so the offer text lost the job's substance and `what` could collapse
  // to a bare verb. A unit after the number (or ON it) means a specification, never a house.
  it("leaves an equipment spec alone: that is how a trade writes a job title", () => {
    for (const text of [
      "Replace 200 Amp Panel",
      "Install 240V Outlet",
      "40 Gallon Water Heater",
      "Fix 300 Gallon Water Heater",
      "Repair 1200 Sq Ft Unit",
      "Replace 200A Panel",
      "Install 1500 Watt Heater",
      "Replace 100W Bulb",
      "Service 410A Line",
    ]) {
      expect(sanitizeVendorFacingText(text)).toBe(text);
    }
  });

  it("still strips the house shapes, and never takes lowercase prose for an address", () => {
    expect(sanitizeVendorFacingText("Leak at 5259 Brooklyn")).toBe("Leak");
    expect(sanitizeVendorFacingText("Lockout 4709A 8th Ave")).toBe("Lockout");
    expect(sanitizeVendorFacingText("4709B Brooklyn leak")).toBe("leak");
    expect(sanitizeVendorFacingText("Leak 1200 Dexter Ave N")).toBe("Leak");
    // Only `knownPlaces` may take out lowercase prose, because only it knows the house for certain.
    expect(sanitizeVendorFacingText("leak at 5259 brooklyn")).toBe("leak at 5259 brooklyn");
    expect(sanitizeVendorFacingText("leak at 5259 brooklyn", ["5259 Brooklyn"])).toBe("leak");
  });

  // A pattern can only guess at what reads like an address; the run's own house strings are known exactly.
  it("removes the job's own house strings verbatim, whatever shape they are written in", () => {
    const places = ["5259 Brooklyn Ave NE, Seattle, WA 98105", "5259 Brooklyn Ave NE", "The Brooklyn"];
    expect(sanitizeVendorFacingText("Leak in the basement of The Brooklyn", places)).toBe("Leak in the basement of");
    expect(sanitizeVendorFacingText("Leak at 5259 Brooklyn Ave NE, Seattle, WA 98105", places)).toBe("Leak");
    // Case does not matter, and nothing of the longer string is left behind by removing the shorter one first.
    expect(sanitizeVendorFacingText("leak at the brooklyn", places)).toBe("leak");
  });

  it("keeps a street address out of the offer text even when it came in through `what`", () => {
    const text = composeVendorOfferText({
      handle: 7,
      details: { what: sanitizeVendorFacingText("Lockout at 5259 Brooklyn Ave NE"), area: "University District" },
      payCents: 12000,
      payModel: "flat",
    });
    expect(text).toContain("University District");
    expect(text).not.toMatch(/5259|Brooklyn/);
  });
});

describe("a vendor candidate's label", () => {
  const row = { buildingName: "5259 Brooklyn", address: "5259 Brooklyn Ave NE, Seattle, WA 98105" };

  it("is the general area, never the house or the street", () => {
    expect(propertyLabel(row)).toBe("5259 Brooklyn");
    expect(propertyGeneralArea(row)).toBe("Seattle");
    expect(propertyGeneralArea(row)).not.toMatch(/5259|Brooklyn/);
  });

  it("is empty when no area can be told, so the caller names the workspace instead of a placeholder", () => {
    expect(propertyGeneralArea({ buildingName: "412 Pine St", address: "412 Pine St" })).toBe("");
    expect(propertyGeneralArea({})).toBe("");
  });

  it("never puts a street into the disambiguation question", () => {
    const question = buildDisambiguationQuestion([
      resident({ label: "Fremont House" }),
      vendor({ label: "5259 Brooklyn", generalArea: "Seattle", workspaceName: "Hale Properties" }),
    ]);
    expect(question).toContain("your job at Seattle");
    expect(question).not.toMatch(/5259|Ave NE/);
  });

  // Review fix, Oct 20. `generalArea` is empty for every house whose address carries no comma-separated city, and
  // the old fallback was `candidate.label` - the buildingName or the street. So exactly the houses with no city
  // were the ones whose address went to a vendor who had only been OFFERED the job.
  it("falls back to the workspace name, never to the house, when no area can be told", () => {
    const candidate = vendor({ label: "412 Pine St", workspaceName: "Hale Properties" });
    expect(spokenLabelFor(candidate)).toBe("Hale Properties");
    const question = buildDisambiguationQuestion([resident({ label: "Fremont House" }), candidate]);
    expect(question).toBe("Is this about Fremont House or your job at Hale Properties?");
    expect(question).not.toMatch(/412|Pine/);
  });

  it("falls back to a generic phrase when there is no workspace name either", () => {
    const candidate = vendor({ label: "5259 Brooklyn Ave NE" });
    expect(spokenLabelFor(candidate)).toBe(VENDOR_PLACE_FALLBACK);
    expect(spokenLabelFor(candidate)).not.toMatch(/5259|Brooklyn/);
    expect(buildDisambiguationQuestion([resident({ label: "Fremont House" }), candidate])).not.toMatch(/5259|Brooklyn/);
  });

  it("leaves a NON-vendor candidate naming its own house: a resident knows where they live", () => {
    expect(spokenLabelFor(resident({ label: "5259 Brooklyn" }))).toBe("5259 Brooklyn");
  });
});

describe("reading a prospect's offer pick", () => {
  const offers: LeadOffer[] = [
    { n: 1, propertyId: "p1", roomId: "r1", label: "Fremont House", rent: 900, availability: null },
    { n: 2, propertyId: "p2", roomId: "r2", label: "Ballard House", rent: 950, availability: null },
  ];

  it("takes a marker or a digit-only message", () => {
    expect(parseOfferPick("2", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(parseOfferPick("2.", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(parseOfferPick("#2", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(parseOfferPick("option 2", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(parseOfferPick("the 2", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
    expect(parseOfferPick("second", offers)).toMatchObject({ kind: "pick", offer: { n: 2 } });
  });

  it("does NOT read an answer to a qualifying question as a pick", () => {
    expect(parseOfferPick("2 people", offers).kind).not.toBe("pick");
    expect(parseOfferPick("1 bed", offers).kind).not.toBe("pick");
    expect(parseOfferPick("2 bedrooms if you have them", offers).kind).not.toBe("pick");
  });
});
