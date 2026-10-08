import { describe, expect, it } from "vitest";

import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import {
  buildListingPostText,
  listingChannelEligibility,
  listingHoldFact,
} from "@/lib/listing-channels/post-text";

const CONTACT = { phone: "(206) 555-0100", email: "work@proplane.test" };

/** A publicListingProjection-shaped listing. */
function projected(overrides: Partial<MockProperty> = {}, sub: Record<string, unknown> = {}): MockProperty {
  return {
    id: "prop-1",
    title: "Ballard House",
    address: "123 Main St",
    zip: "98107",
    neighborhood: "Ballard",
    beds: 3,
    baths: 2,
    available: "Now",
    buildingName: "Ballard House",
    listingSubmission: {
      v: 1,
      buildingName: "Ballard House",
      address: "123 Main St",
      houseOverview: "A lovely home near the water. Quiet street.",
      housePhotoDataUrls: ["https://cdn.proplane.test/photo1.jpg"],
      entireHomeMonthlyRent: 2200,
      listingPlaceCategoryId: "entire_home",
      rooms: [],
      quickFacts: [{ id: "q1", label: "Laundry", value: "In unit" }],
      ...sub,
    } as unknown as ManagerListingSubmissionV1,
    ...overrides,
  } as unknown as MockProperty;
}

function build(
  property: MockProperty,
  channel: Parameters<typeof buildListingPostText>[0]["channel"] = "facebook_marketplace",
  contact = CONTACT,
  attribution = true,
) {
  return buildListingPostText({ property, origin: "https://proplane.ai", contact, channel, attribution });
}

describe("listing post text", () => {
  it("ends with the Listed with PropLane line when attribution is on", () => {
    const result = build(projected());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paragraphs = result.text.split("\n\n");
    expect(paragraphs[paragraphs.length - 1]).toBe("Listed with PropLane — free for landlords: https://proplane.ai/partner");
  });

  it("leaves the line out when attribution is off, and keeps the link and contact", () => {
    const result = build(projected(), "facebook_marketplace", CONTACT, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("Listed with PropLane");
    expect(result.text).toContain("Text (206) 555-0100");
  });

  it("keeps the attribution line on every channel even when the body is trimmed to the limit", () => {
    const long = projected({}, { houseOverview: "A lovely home near the water. ".repeat(40) });
    for (const channel of ["instagram", "craigslist", "roomster", "google_business_profile"] as const) {
      const result = build(long, channel);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.text.endsWith("https://proplane.ai/partner")).toBe(true);
      expect(result.text).toContain("Text (206) 555-0100");
    }
  });

  it("carries the headline, price, facts, link and the workspace work number and email", () => {
    const result = build(projected());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Ballard House");
    expect(result.text).toContain("$2,200/mo");
    expect(result.text).toContain("3 bed");
    expect(result.text).toContain("Laundry: In unit");
    expect(result.text).toContain("https://proplane.ai/");
    expect(result.text).toContain("Text (206) 555-0100");
    expect(result.text).toContain("Email work@proplane.test");
  });

  it("with no work number nothing is built, and the row says Set up work number", () => {
    expect(build(projected(), "facebook_marketplace", { phone: null, email: "work@proplane.test" })).toEqual({ ok: false, reason: "no_work_number" });
    expect(build(projected(), "facebook_marketplace", { phone: "  ", email: null })).toEqual({ ok: false, reason: "no_work_number" });
    expect(listingHoldFact(["no_work_number"])).toBe("Set up work number");
    expect(listingHoldFact(["no_photo", "no_work_number"])).toBe("Held: no photo · Set up work number");
  });

  it("an email-less workspace still posts with the number alone", () => {
    const result = build(projected(), "facebook_marketplace", { phone: CONTACT.phone, email: null });
    expect(result.ok && result.text).toContain("Text (206) 555-0100");
    expect(result.ok && result.text).not.toContain("Email");
  });

  it("reads only projection fields: a manager-internal field never reaches the post", () => {
    const leaky = projected(
      { contactSmsPhone: "+19999999999", managerContactEmail: "personal@example.com" } as Partial<MockProperty>,
      {
        syndication: { zillow: { enabled: true, reasons: ["SECRET-REASON"] } },
        wifiPassword: "SECRET-WIFI",
        houseRulesText: "SECRET-RULES",
      },
    );
    const result = build(leaky);
    expect(result.ok).toBe(true);
    const text = result.ok ? result.text : "";
    for (const secret of ["SECRET-REASON", "SECRET-WIFI", "SECRET-RULES", "+19999999999", "personal@example.com"]) {
      expect(text).not.toContain(secret);
    }
    // The contact is the workspace's resolved work contact, not anything on the stored listing.
    expect(text).toContain("(206) 555-0100");
  });

  it("each channel trims the body to its own limit but never cuts the link or contact lines", () => {
    const long = projected({}, { houseOverview: `${"A very long overview sentence. ".repeat(80)}` });
    for (const channel of ["instagram", "craigslist", "roomster", "google_business_profile"] as const) {
      const result = build(long, channel);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const limit = { instagram: 2200, craigslist: 5000, roomster: 2000, google_business_profile: 1500 }[channel];
      expect(result.text.length).toBeLessThanOrEqual(limit);
      expect(result.text).toContain("Text (206) 555-0100");
      expect(result.text).toContain("https://proplane.ai/");
    }
  });

  it("by-room listings say 'From' the cheapest room", () => {
    const byRoom = projected({}, {
      listingPlaceCategoryId: "by_room",
      entireHomeMonthlyRent: undefined,
      rooms: [
        { id: "r1", monthlyRent: 900 },
        { id: "r2", monthlyRent: 1100 },
      ],
    });
    const result = build(byRoom);
    expect(result.ok && result.text).toContain("From $900/mo");
  });
});

describe("listing eligibility", () => {
  it("a listing with a street address and a real photo is eligible", () => {
    expect(listingChannelEligibility(projected())).toEqual([]);
  });

  it("holds a listing with no photo, with the reason, and never substitutes a placeholder", () => {
    const noPhoto = projected({}, { housePhotoDataUrls: [], rooms: [] });
    expect(listingChannelEligibility(noPhoto)).toEqual(["no_photo"]);
    expect(listingHoldFact(["no_photo"])).toBe("Held: no photo");
  });

  it("a data: URL or empty string is not a real photo", () => {
    expect(listingChannelEligibility(projected({}, { housePhotoDataUrls: ["data:image/png;base64,AAAA", ""] }))).toEqual(["no_photo"]);
  });

  it("holds a listing with no street address", () => {
    expect(listingChannelEligibility(projected({ address: "  " }))).toEqual(["no_street_address"]);
    expect(listingHoldFact(["no_street_address", "no_photo"])).toBe("Held: no street address and no photo");
  });
});
