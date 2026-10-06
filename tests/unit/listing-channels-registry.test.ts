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
  requestAccessMailto,
} from "@/lib/listing-channels/registry";

describe("listing channel registry", () => {
  it("has exactly the three groups the plan names, with the agreed sites in each", () => {
    expect(listingChannelsByGroup("automatic").map((c) => c.id)).toEqual(["zillow", "facebook_page", "instagram"]);
    expect(listingChannelsByGroup("one_click").map((c) => c.id)).toEqual([
      "facebook_marketplace",
      "facebook_groups",
      "roomster",
      "roomies",
      "furnished_finder",
      "craigslist",
    ]);
    expect(listingChannelsByGroup("request_access").map((c) => c.id)).toEqual([
      "zumper_padmapper",
      "apartments_com",
      "apartment_list",
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

  it("Request access opens a mail draft naming the site", () => {
    const href = requestAccessMailto({ label: "Zumper and PadMapper" });
    expect(href.startsWith("mailto:")).toBe(true);
    expect(decodeURIComponent(href)).toContain("Request access: Zumper and PadMapper");
  });
});
