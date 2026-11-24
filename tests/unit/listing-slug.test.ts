import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildListingSlugIndex,
  EMPTY_LISTING_SLUG_INDEX,
  listingCanonicalSlug,
  listingIdToken,
  listingPublicPathFor,
  listingSlugFor,
  resolveListingParam,
  slugifyAddress,
} from "@/lib/listing-slug";
import { buildManagerListingUrl } from "@/lib/manager-property-links";
import { listingJsonLd } from "@/lib/seo/json-ld";
import type { MockProperty } from "@/data/types";

const home = (id: string, address: string): MockProperty => ({ id, address, title: address, zip: "98105" }) as MockProperty;

const A = home("mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg", "4709A 8th Ave NE, Seattle, WA 98105");
const B = home("prop-b-0001", "5257 Brooklyn Ave NE, Seattle, WA 98105");

describe("slugifyAddress", () => {
  it("lower-cases, folds accents and keeps only a-z0-9 and single hyphens", () => {
    expect(slugifyAddress("4709A 8th Ave NE")).toBe("4709a-8th-ave-ne");
    expect(slugifyAddress("  Calle Ñandú #5, Apt. 2/B  ")).toBe("calle-nandu-5-apt-2-b");
    expect(slugifyAddress("---")).toBe("");
  });
});

describe("listingSlugFor", () => {
  it("is built from the current street line, not the city or ZIP", () => {
    expect(listingSlugFor(A)).toBe("4709a-8th-ave-ne");
  });
  it("has no slug without a street address, so the listing keeps its id URL", () => {
    expect(listingSlugFor(home("x1", ""))).toBeNull();
    expect(listingSlugFor(home("x2", "   "))).toBeNull();
    expect(listingSlugFor(home("x3", ", Seattle, WA"))).toBeNull();
  });
});

describe("listingIdToken", () => {
  it("uses the trailing random token of a minted id", () => {
    expect(listingIdToken(A.id)).toBe("7mdlyj0h2vfg");
  });
  it("hashes an id without one: stable, url-safe, different per id", () => {
    const t = listingIdToken("prop-b-0001");
    expect(t).toMatch(/^h[a-z0-9]{6,12}$/);
    expect(listingIdToken("prop-b-0001")).toBe(t);
    expect(listingIdToken("prop-b-0002")).not.toBe(t);
  });
});

describe("canonical slug", () => {
  it("is the street line plus the id token, whatever the building was copied from", () => {
    expect(listingCanonicalSlug(A)).toBe("4709a-8th-ave-ne-7mdlyj0h2vfg");
    expect(listingPublicPathFor(A)).toBe("/rent/listings/4709a-8th-ave-ne-7mdlyj0h2vfg");
  });
  it("names the listing's OWN address for the three live houses even though their ids were copied from another house", () => {
    const h4709 = home("mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg", "4709A 8th Ave NE, Seattle, WA 98105");
    const h5259 = home("mgr-5257-brooklyn-ave-copy-4-rooms-1x3tiu8k2mnq", "5259 Brooklyn Ave NE, Seattle, WA 98105");
    const h5257 = home("mgr-4709a-8th-ave-copy-3-rooms-9qwerty1zxcv", "5257 Brooklyn Ave NE, Seattle, WA 98105");
    expect(listingCanonicalSlug(h4709)).toMatch(/^4709a-8th-ave-ne-/);
    expect(listingCanonicalSlug(h5259)).toMatch(/^5259-brooklyn-ave-ne-/);
    expect(listingCanonicalSlug(h5257)).toMatch(/^5257-brooklyn-ave-ne-/);
    for (const h of [h4709, h5259, h5257]) expect(listingCanonicalSlug(h)).not.toContain("copy");
  });
  it("is stable when another listing joins the catalog or shares the address", () => {
    const twin = home("prop-twin-aaaa1111zz", "4709A 8th Ave NE, Seattle, WA");
    expect(buildListingSlugIndex([A]).idToSlug.get(A.id)).toBe(buildListingSlugIndex([twin, A, B]).idToSlug.get(A.id));
  });
  it("gives a listing with no street address a `listing-<token>` slug", () => {
    expect(listingCanonicalSlug(home("blank-0000aaaabbbb", ""))).toBe("listing-0000aaaabbbb");
  });
});

describe("buildListingSlugIndex", () => {
  it("maps id to slug and token to id", () => {
    const index = buildListingSlugIndex([A, B]);
    expect(index.idToSlug.get(A.id)).toBe("4709a-8th-ave-ne-7mdlyj0h2vfg");
    expect(index.tokenToId.get(listingIdToken(B.id))).toBe(B.id);
  });
  it("drops a token shared by two different ids so neither resolves to the wrong home", () => {
    const index = buildListingSlugIndex([home("a-x-abc12345", "1 Oak Ln"), home("b-y-abc12345", "2 Oak Ln")]);
    expect(index.idToSlug.size).toBe(0);
    expect(index.tokenToId.size).toBe(0);
  });
});

describe("resolveListingParam", () => {
  const index = buildListingSlugIndex([A, B]);
  const slugA = "4709a-8th-ave-ne-7mdlyj0h2vfg";

  it("redirects the old record id to the canonical slug", () => {
    expect(resolveListingParam(index, A.id)).toEqual({ kind: "redirect", slug: slugA, id: A.id });
  });
  it("renders the canonical slug", () => {
    expect(resolveListingParam(index, slugA)).toEqual({ kind: "slug", id: A.id });
  });
  it("a renamed title (stale slug) still resolves by the token and redirects to the current slug", () => {
    expect(resolveListingParam(index, "old-name-7mdlyj0h2vfg")).toEqual({ kind: "redirect", slug: slugA, id: A.id });
  });
  it("an unknown param is passed through as an id (the existing not-found state)", () => {
    expect(resolveListingParam(index, "no-such-house")).toEqual({ kind: "id", id: "no-such-house" });
    expect(resolveListingParam(index, "nope-zzzzzzzzzzzz")).toEqual({ kind: "id", id: "nope-zzzzzzzzzzzz" });
    expect(resolveListingParam(EMPTY_LISTING_SLUG_INDEX, A.id)).toEqual({ kind: "id", id: A.id });
  });
});

describe("URL builders stay derived from the module", () => {
  it("buildManagerListingUrl emits the canonical path for a listing in hand, the slug when given, the id URL otherwise", () => {
    expect(buildManagerListingUrl("https://proplane.ai/", A.id, A)).toBe("https://proplane.ai/rent/listings/4709a-8th-ave-ne-7mdlyj0h2vfg");
    expect(buildManagerListingUrl("https://proplane.ai/", A.id, "x-7mdlyj0h2vfg")).toBe("https://proplane.ai/rent/listings/x-7mdlyj0h2vfg");
    expect(buildManagerListingUrl("https://proplane.ai", "blank 1")).toBe("https://proplane.ai/rent/listings/blank%201");
  });
  it("JSON-LD carries the canonical URL on the accommodation and its offer", () => {
    const url = "https://proplane.ai/rent/listings/4709a-8th-ave-ne-7mdlyj0h2vfg";
    const ld = listingJsonLd({ ...A, rentLabel: "$900/mo" } as MockProperty, "https://proplane.ai") as { url: string; offers?: { url: string } };
    expect(ld.url).toBe(url);
    expect(ld.offers?.url).toBe(url);
  });
  it("the sitemap, the listing page, the canonical lookup and the middleware read the one slug module", () => {
    const sitemap = readFileSync(join(process.cwd(), "src/app/sitemap.ts"), "utf8");
    expect(sitemap).toContain("listingCanonicalSlug");
    expect(sitemap).not.toContain("encodeURIComponent(p.id)");
    const page = readFileSync(join(process.cwd(), "src/app/(rent)/rent/listings/[id]/page.tsx"), "utf8");
    expect(page).toContain("canonical");
    expect(page).not.toContain("permanentRedirect");
    const mw = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(mw).toContain("/api/public/listing-canonical");
    expect(mw).toContain("308");
  });
});

describe("/rent/tour", () => {
  it("is a temporary redirect to /rent/tours-contact (never cached as a 308)", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/source:\s*"\/rent\/tour",\s*destination:\s*"\/rent\/tours-contact",\s*permanent:\s*false/);
  });
});
