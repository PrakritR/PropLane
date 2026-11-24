// Every listing URL in the generated sitemap must be one the listing router resolves to that listing.
//
// `/sitemap.xml` is a generated public artifact and the router (`resolveListingParam` over the same catalog) is the
// independent consumer that says what each URL means. Two listings whose ids share an id token have NO unique slug -
// `buildListingSlugIndex` drops both on purpose so they keep their id URL - and the plausible wrong behaviour this
// rejects is advertising a readable slug for them anyway: the crawler then indexes a not-found page.
import { describe, expect, it, vi } from "vitest";

const LISTINGS = [
  { id: "prop-a-7mdlyj0h2vfg", address: "4709A 8th Ave NE, Seattle, WA" },
  { id: "prop-b-7mdlyj0h2vfg", address: "4709A 8th Ave NE, Seattle, WA" },
  { id: "prop-solo-x2k9qm4w1abc", address: "12 Elm St, Louisville, KY" },
];

vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => LISTINGS }));

import sitemap from "@/app/sitemap";
import { LISTING_PATH_PREFIX, buildListingSlugIndex, resolveListingParam } from "@/lib/listing-slug";

describe("the sitemap's listing URLs", () => {
  it("advertises only URLs that resolve to the listing they name", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    const index = buildListingSlugIndex(LISTINGS as never);

    for (const listing of LISTINGS) {
      const url = urls.find((candidate) => {
        const param = decodeURIComponent(candidate.split(`${LISTING_PATH_PREFIX}/`)[1] ?? "");
        const resolution = resolveListingParam(index, param);
        return resolution.id === listing.id;
      });
      expect(url, `no resolving sitemap URL for ${listing.id}`).toBeDefined();
    }

    const listingUrls = urls.filter((candidate) => candidate.includes(`${LISTING_PATH_PREFIX}/`));
    expect(listingUrls).toHaveLength(LISTINGS.length);
    // The two id-token twins keep their id URL; only the listing with a unique token gets the readable slug.
    expect(listingUrls).toContain(`https://proplane.ai${LISTING_PATH_PREFIX}/prop-a-7mdlyj0h2vfg`);
    expect(listingUrls).toContain(`https://proplane.ai${LISTING_PATH_PREFIX}/12-elm-st-x2k9qm4w1abc`);
  });
});
