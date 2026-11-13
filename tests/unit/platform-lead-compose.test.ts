/** design-1112 §6: composePlatformReply per site - what each site allows, and the TEXT line everywhere a phone is allowed. */
import { describe, expect, it } from "vitest";
import { CHANNEL_CAPABILITIES, composePlatformReply } from "@/lib/platform-leads/index.server";
import { PLATFORM_SOURCES, type PlatformSource } from "@/lib/prospect-spine/contracts";

const base = {
  answer: "Thanks for reaching out! Room 9 is a furnished room. See https://prop-lane.space/rent/4709a and email us at host@example.com or call 425-555-0100.",
  propertyLabel: "4709a 8th Ave NE",
  roomLabel: "Room 9",
  listingUrl: "https://prop-lane.space/rent/4709a",
  textNumberDisplay: "(206) 678-1909",
  stitchCode: "K7Q2",
};
const compose = (site: PlatformSource, over: Partial<typeof base> = {}) => composePlatformReply({ site, ...base, ...over });

describe("capability table", () => {
  it("has a row for every platform source, and the captain's per-site rules", () => {
    for (const site of PLATFORM_SOURCES) expect(CHANNEL_CAPABILITIES[site].site).toBe(site);
    expect(CHANNEL_CAPABILITIES.craigslist).toMatchObject({ replyMode: "email_relay", allowsLinkInMessage: false, allowsPhoneInMessage: true });
    expect(CHANNEL_CAPABILITIES.zillow).toMatchObject({ replyMode: "email_relay", allowsLinkInMessage: true });
    for (const site of ["roomies", "facebook", "roomster"] as const) expect(CHANNEL_CAPABILITIES[site].replyMode).toBe("manual_copy");
    expect(CHANNEL_CAPABILITIES.facebook.allowsLinkInMessage).toBe(false);
    expect(CHANNEL_CAPABILITIES.roomster.allowsLinkInMessage).toBe(false);
  });
});

describe("composePlatformReply", () => {
  it("every lead site's body carries the 206 number in display form and the stitch code", () => {
    for (const site of ["spareroom", "roomies", "zillow", "craigslist", "facebook", "roomster"] as const) {
      const { body } = compose(site);
      expect(body).toContain("(206) 678-1909");
      expect(body).toContain("Please TEXT (206) 678-1909 and mention K7Q2");
      expect(body).toContain("4709a 8th Ave NE");
      expect(body).not.toContain("host@example.com");
      expect(body).not.toContain("425-555-0100");
    }
  });
  it("Craigslist (plain text) has no URL at all; Facebook and Roomster neither", () => {
    for (const site of ["craigslist", "facebook", "roomster"] as const) {
      const { body, removed } = compose(site);
      expect(body).not.toMatch(/https?:\/\/|www\.|prop-lane/);
      expect(removed).toEqual(expect.arrayContaining(["link", "email", "phone"]));
    }
  });
  it("Zillow, SpareRoom and Roomies keep the listing link", () => {
    for (const site of ["zillow", "spareroom", "roomies"] as const) expect(compose(site).body).toContain("https://prop-lane.space/rent/4709a");
  });
  it("adds the property line when the answer never named it, and never twice", () => {
    expect(compose("zillow", { answer: "Yes, it is open." }).body).toContain("About: 4709a 8th Ave NE, Room 9.");
    expect(compose("zillow", { answer: "4709a 8th Ave NE is open." }).body).not.toContain("About:");
  });
  it("without a stitch code the text line still goes out", () => {
    expect(compose("craigslist", { stitchCode: null }).body).toContain("Please TEXT (206) 678-1909 so we can answer quickly.");
  });
  it("Airbnb and Booking.com stay contact-free", () => {
    for (const site of ["airbnb", "booking_com"] as const) {
      const { body } = compose(site);
      expect(body).not.toContain("678-1909");
      expect(body).not.toMatch(/https?:/);
    }
  });
});
