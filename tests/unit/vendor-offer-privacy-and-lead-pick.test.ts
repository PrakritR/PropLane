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
import { buildDisambiguationQuestion } from "@/lib/one-number/router.server";
import { propertyGeneralArea, propertyLabel } from "@/lib/one-number/router-lookups.server";
import { parseOfferPick } from "@/lib/one-number/lead-match";
import type { LeadOffer } from "@/lib/one-number/lead-match";

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
      { workspaceId: "w1", ownerUserId: "o1", role: "resident", reason: "resident", propertyId: "p1", label: "Fremont House" },
      { workspaceId: "w2", ownerUserId: "o2", role: "vendor", reason: "vendor_job", propertyId: "p2", label: propertyGeneralArea(row) || "Hale Properties" },
    ]);
    expect(question).toContain("your job at Seattle");
    expect(question).not.toMatch(/5259|Ave NE/);
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
