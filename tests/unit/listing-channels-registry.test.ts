import { describe, expect, it } from "vitest";

import {
  LISTING_CHANNEL_DEFS,
  RETIRED_PARTNER_CONTACTS,
  apiPostingChannelIds,
  listingChannelAvailability,
  listingChannelDef,
  listingChannels,
  listingChannelsOrdered,
  metaAppConfigured,
  metaChannelsLive,
  partnerContactHref,
  partnerContactHrefs,
} from "@/lib/listing-channels/registry";

const ORDER = [
  "zillow",
  "facebook_marketplace",
  "facebook_groups",
  "craigslist",
  "spareroom",
  "roomies",
  "roomster",
  "zumper_padmapper",
  "apartments_com",
  "redfin_rent",
  "apartment_list",
  "furnished_finder",
  "nextdoor",
  "reddit",
  "facebook_page",
  "instagram",
];

describe("listing channel registry", () => {
  it("lists the 16 agreed sites in reach order, with Redfin and Reddit added and Google Business Profile and LinkedIn gone", () => {
    expect(listingChannelsOrdered().map((c) => c.id)).toEqual(ORDER);
    expect(new Set(LISTING_CHANNEL_DEFS.map((c) => c.id)).size).toBe(LISTING_CHANNEL_DEFS.length);
    expect(listingChannelDef("google_business_profile")).toBeNull();
    expect(listingChannelDef("linkedin")).toBeNull();
  });

  it("every channel has a posting mode and a complete guide", () => {
    for (const def of LISTING_CHANNEL_DEFS) {
      expect(["feed", "api", "manual", "partner_only"]).toContain(def.posting);
      expect(def.guide.how.length, def.id).toBeGreaterThan(10);
      if (def.posting === "partner_only") {
        expect(def.createUrl).toBeUndefined();
        continue;
      }
      expect(def.guide.signupUrl, def.id).toMatch(/^https:\/\//);
      expect(def.guide.createUrl, def.id).toMatch(/^https:\/\//);
      expect(def.guide.signupNote, def.id).toBeTruthy();
      expect(def.guide.createNote, def.id).toBeTruthy();
      expect(def.guide.cost, def.id).toBeTruthy();
      expect(def.guide.rules.length, def.id).toBeGreaterThan(0);
    }
  });

  it("the queue only ever touches Meta's API channels; Zillow is a feed", () => {
    expect(apiPostingChannelIds()).toEqual(["facebook_page", "instagram"]);
    expect(listingChannelDef("zillow")?.mode).toBe("feed");
    expect(listingChannelDef("apartment_list")?.posting).toBe("partner_only");
  });

  it("feed and manual sites are live, partner-only is partner_only, and nothing is a dead Coming soon row without Meta", () => {
    const byId = Object.fromEntries(listingChannels({}).map((c) => [c.id, c.availability]));
    for (const def of LISTING_CHANNEL_DEFS) {
      if (def.posting === "feed" || def.posting === "manual") expect(byId[def.id], def.id).toBe("live");
      if (def.posting === "partner_only") expect(byId[def.id], def.id).toBe("partner_only");
    }
    expect(byId.facebook_page).toBe("coming_soon");
  });

  it("Facebook Page and Instagram are Coming soon when the Meta env is missing", () => {
    for (const env of [{}, { META_APP_ID: "1" }, { META_APP_ID: "1", META_APP_SECRET: "s" }, { META_APP_SECRET: "s", META_APP_LIVE: "1" }]) {
      expect(metaChannelsLive(env)).toBe(false);
      expect(listingChannelAvailability(listingChannelDef("facebook_page")!, env)).toBe("coming_soon");
      expect(listingChannelAvailability(listingChannelDef("instagram")!, env)).toBe("coming_soon");
    }
  });

  it("they go live only with id + secret + META_APP_LIVE=1; OAuth can start with id + secret alone", () => {
    const env = { META_APP_ID: "1", META_APP_SECRET: "s", META_APP_LIVE: "1" };
    expect(metaChannelsLive(env)).toBe(true);
    expect(listingChannelAvailability(listingChannelDef("facebook_page")!, env)).toBe("live");
    expect(listingChannelAvailability(listingChannelDef("instagram")!, env)).toBe("live");
    expect(metaAppConfigured({ META_APP_ID: "1", META_APP_SECRET: "s" })).toBe(true);
    expect(metaChannelsLive({ META_APP_ID: "1", META_APP_SECRET: "s", META_APP_LIVE: "0" })).toBe(false);
  });

  it("partner-contact channels carry their company's real contact; the retired two stay available to the admin kit", () => {
    const hrefs = partnerContactHrefs();
    expect(hrefs.zumper_padmapper).toMatch(/^mailto:directlistings@zumper\.com/);
    expect(hrefs.apartments_com).toMatch(/^mailto:feeds@apartments\.com/);
    expect(hrefs.apartment_list).toMatch(/^mailto:clientservices@apartmentlist\.com/);
    expect(hrefs.furnished_finder).toMatch(/^mailto:partnerships@furnishedfinder\.com/);
    expect(hrefs.nextdoor).toMatch(/^https:\/\//);
    expect(RETIRED_PARTNER_CONTACTS.google_business_profile?.contact).toMatchObject({ kind: "url" });
    expect(RETIRED_PARTNER_CONTACTS.linkedin?.contact).toMatchObject({ kind: "url" });
    expect(JSON.stringify(hrefs)).not.toContain("support@proplane.ai");
    expect(partnerContactHref({ label: "x" })).toBeNull();
  });
});
