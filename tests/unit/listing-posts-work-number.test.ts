/**
 * Captain's order (2026-10-07): whenever a listing is posted it carries the WORKSPACE work number
 * (and work email), never a personal phone, and no work number means the post is held.
 * This pins that across every channel builder, the Zillow feed, and the flyer / promotion contact.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MockProperty } from "@/data/types";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { LISTING_CHANNEL_DEFS } from "@/lib/listing-channels/registry";
import { buildListingPostText } from "@/lib/listing-channels/post-text";
import { buildZillowRentalFeedXml } from "@/lib/listing-syndication/zillow-feed";
import { promotionWorkContactLine } from "@/lib/promotion-default-sync";

const WORK = { phone: "(206) 555-0100", email: "work@proplane.test" };
const PERSONAL_PHONE = "(415) 555-0199";
const PERSONAL_EMAIL = "personal@example.com";

function listing(): MockProperty {
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
    // Fields a stored blob could carry: they must never reach a post.
    contactSmsPhone: "+12065550100",
    contactWorkEmail: WORK.email,
    managerPhone: PERSONAL_PHONE,
    managerEmail: PERSONAL_EMAIL,
    listingSubmission: {
      v: 1,
      buildingName: "Ballard House",
      address: "123 Main St",
      houseOverview: "A lovely home near the water.",
      housePhotoDataUrls: ["https://cdn.proplane.test/photo1.jpg"],
      entireHomeMonthlyRent: 2200,
      listingPlaceCategoryId: "entire_home",
      rooms: [],
      quickFacts: [],
    } as unknown as ManagerListingSubmissionV1,
  } as unknown as MockProperty;
}

describe("every channel builder carries the work number or holds", () => {
  it("covers every channel in the registry", () => {
    expect(LISTING_CHANNEL_DEFS.length).toBeGreaterThan(10);
  });

  for (const def of LISTING_CHANNEL_DEFS) {
    it(`${def.id}: work number and email in the post, never a personal contact`, () => {
      const result = buildListingPostText({
        property: listing(),
        origin: "https://proplane.ai",
        contact: WORK,
        channel: def.id,
        attribution: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain(`Text ${WORK.phone}`);
      expect(result.text).toContain(`Email ${WORK.email}`);
      expect(result.text).not.toContain(PERSONAL_PHONE);
      expect(result.text).not.toContain(PERSONAL_EMAIL);
    });

    it(`${def.id}: no work number holds the post`, () => {
      for (const phone of [null, "", "   "]) {
        expect(
          buildListingPostText({
            property: listing(),
            origin: "https://proplane.ai",
            contact: { phone, email: WORK.email },
            channel: def.id,
            attribution: true,
          }),
        ).toEqual({ ok: false, reason: "no_work_number" });
      }
    });
  }
});

describe("Zillow feed", () => {
  it("publishes only the work number and leaves a listing with none out", () => {
    const withPhone = { ...listing(), contactSmsPhone: "+12065550100" } as MockProperty;
    const without = { ...listing(), id: "prop-2", contactSmsPhone: undefined } as MockProperty;
    const { xml, includedIds, excluded } = buildZillowRentalFeedXml([withPhone, without], "https://proplane.ai");
    expect(includedIds).toEqual(["prop-1"]);
    expect(excluded).toEqual([{ propertyId: "prop-2", reasons: ["no_work_number"] }]);
    expect(xml).toContain("<contactPhone>+12065550100</contactPhone>");
    expect(xml).not.toContain(PERSONAL_PHONE);
    expect(xml).not.toContain(PERSONAL_EMAIL);
  });
});

describe("flyer and promotion contact line", () => {
  it("is the work number plus the work email, nothing else", () => {
    expect(promotionWorkContactLine("(206) 555-0100", "work@proplane.test")).toBe("(206) 555-0100 · work@proplane.test");
    expect(promotionWorkContactLine("(206) 555-0100", null)).toBe("(206) 555-0100");
  });

  it("is empty without a work number: no PropLane support line or email stands in", () => {
    expect(promotionWorkContactLine(null, "work@proplane.test")).toBe("");
    expect(promotionWorkContactLine("  ", null)).toBe("");
    const source = readFileSync(path.join(process.cwd(), "src/lib/promotion-default-sync.ts"), "utf8");
    expect(source).not.toContain("PUBLIC_SUPPORT_PHONE_DISPLAY");
    expect(source).not.toContain("PUBLIC_LEASING_EMAIL");
  });
});

describe("the queue resolves contact from the workspace only", () => {
  it("never reads profiles.phone or the stored blob for a post", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/listing-channels/sync.server.ts"), "utf8");
    expect(source).toContain("resolveActiveManagerSendNumber");
    expect(source).toContain("resolveActiveManagerWorkEmail");
    expect(source).not.toMatch(/profiles?\.phone|managerPhone|\.from\("profiles"\)/);
    expect(source).toContain('reasons.push("no_work_number")');
  });
});
