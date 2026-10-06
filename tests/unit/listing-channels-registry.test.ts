import { describe, expect, it } from "vitest";

import {
  LISTING_CHANNEL_DEFS,
  apiPostingChannelIds,
  listingChannelAvailability,
  listingChannelDef,
  listingChannels,
  listingChannelsByGroup,
  metaAppConfigured,
  metaChannelsLive,
  partnerContactHref,
  partnerContactHrefs,
} from "@/lib/listing-channels/registry";

describe("listing channel registry", () => {
  it("has exactly the three groups the plan names, with the agreed sites in each", () => {
    expect(listingChannelsByGroup("automatic").map((c) => c.id)).toEqual(["zillow", "facebook_page", "instagram"]);
    expect(listingChannelsByGroup("one_click").map((c) => c.id)).toEqual([
      "facebook_marketplace",
      "facebook_groups",
      "roomster",
      "roomies",
      "craigslist",
    ]);
    expect(listingChannelsByGroup("request_access").map((c) => c.id)).toEqual([
      "zumper_padmapper",
      "apartments_com",
      "apartment_list",
      "furnished_finder",
      "spareroom",
      "nextdoor",
      "google_business_profile",
      "linkedin",
    ]);
    expect(new Set(LISTING_CHANNEL_DEFS.map((c) => c.id)).size).toBe(LISTING_CHANNEL_DEFS.length);
  });

  it("every one-click channel has an https create page; nothing else carries one", () => {
    for (const def of LISTING_CHANNEL_DEFS) {
      if (def.group === "one_click") expect(def.createUrl).toMatch(/^https:\/\//);
      else expect(def.createUrl).toBeUndefined();
    }
  });

  it("the queue only ever touches Meta's API channels; Zillow is a feed", () => {
    expect(apiPostingChannelIds()).toEqual(["facebook_page", "instagram"]);
    expect(listingChannelDef("zillow")?.mode).toBe("feed");
  });

  it("Zillow and the one-click channels are live; request-access sites are Coming soon", () => {
    const byId = Object.fromEntries(listingChannels({}).map((c) => [c.id, c.availability]));
    expect(byId.zillow).toBe("live");
    for (const def of listingChannelsByGroup("one_click")) expect(byId[def.id]).toBe("live");
    for (const def of listingChannelsByGroup("request_access")) expect(byId[def.id]).toBe("coming_soon");
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

  it("Furnished Finder is Request access (Coming soon) with no create page", () => {
    const def = listingChannelDef("furnished_finder")!;
    expect(def.group).toBe("request_access");
    expect(def.createUrl).toBeUndefined();
    expect(listingChannelAvailability(def)).toBe("coming_soon");
  });

  it("every request-access channel carries its company's real partner contact", () => {
    const hrefs = partnerContactHrefs();
    for (const def of listingChannelsByGroup("request_access")) expect(hrefs[def.id], def.id).toBeTruthy();
    expect(hrefs.zumper_padmapper).toMatch(/^mailto:directlistings@zumper\.com/);
    expect(hrefs.apartments_com).toMatch(/^mailto:feeds@apartments\.com/);
    expect(hrefs.apartment_list).toMatch(/^mailto:clientservices@apartmentlist\.com/);
    expect(hrefs.furnished_finder).toMatch(/^mailto:partnerships@furnishedfinder\.com/);
    expect(hrefs.nextdoor).toMatch(/^https:\/\//);
    expect(hrefs.google_business_profile).toMatch(/^https:\/\//);
    expect(JSON.stringify(hrefs)).not.toContain("support@proplane.ai");
    expect(partnerContactHref({ label: "x" })).toBeNull();
  });
});
