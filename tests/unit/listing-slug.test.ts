import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildListingSlugIndex,
  EMPTY_LISTING_SLUG_INDEX,
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

describe("buildListingSlugIndex", () => {
  it("maps id to slug and back for unique addresses", () => {
    const index = buildListingSlugIndex([A, B]);
    expect(index.idToSlug.get(A.id)).toBe("4709a-8th-ave-ne");
    expect(index.slugToId.get("5257-brooklyn-ave-ne")).toBe(B.id);
  });

  it("appends the last six characters of the id to EVERY listing that shares a slug, in any catalog order", () => {
    const one = home("prop-aaaaaa111111", "10 Main St, Seattle, WA");
    const two = home("prop-bbbbbb222222", "10 Main St., Seattle, WA");
    const forward = buildListingSlugIndex([one, two]);
    const backward = buildListingSlugIndex([two, one]);
    expect(forward.idToSlug.get(one.id)).toBe("10-main-st-111111");
    expect(forward.idToSlug.get(two.id)).toBe("10-main-st-222222");
    expect(forward.slugToId.has("10-main-st")).toBe(false);
    expect([...backward.idToSlug.entries()].sort()).toEqual([...forward.idToSlug.entries()].sort());
  });

  it("drops a slug that is still shared after the suffix, so neither listing resolves to the wrong home", () => {
    const index = buildListingSlugIndex([home("a-x-123456", "1 Oak Ln"), home("b-y-123456", "1 Oak Ln")]);
    expect(index.idToSlug.size).toBe(0);
    expect(index.slugToId.size).toBe(0);
  });

  it("gives a listing with no street address no slug", () => {
    const index = buildListingSlugIndex([A, home("blank-1", "")]);
    expect(index.idToSlug.has("blank-1")).toBe(false);
  });
});

describe("resolveListingParam", () => {
  const index = buildListingSlugIndex([A, B, home("blank-1", "")]);

  it("redirects a known id to its slug", () => {
    expect(resolveListingParam(index, A.id)).toEqual({ kind: "redirect", slug: "4709a-8th-ave-ne" });
  });
  it("resolves a slug back to its property id", () => {
    expect(resolveListingParam(index, "4709a-8th-ave-ne")).toEqual({ kind: "slug", id: A.id });
  });
  it("keeps an id with no slug on its id URL", () => {
    expect(resolveListingParam(index, "blank-1")).toEqual({ kind: "id", id: "blank-1" });
  });
  it("passes a slug that resolves to nothing through as an id, which is the existing not-found state", () => {
    expect(resolveListingParam(index, "no-such-house")).toEqual({ kind: "id", id: "no-such-house" });
    expect(resolveListingParam(EMPTY_LISTING_SLUG_INDEX, A.id)).toEqual({ kind: "id", id: A.id });
  });
});

describe("URL builders stay derived from the module", () => {
  it("buildManagerListingUrl emits the slug when it has one and the id URL otherwise", () => {
    expect(buildManagerListingUrl("https://proplane.ai/", A.id, "4709a-8th-ave-ne")).toBe("https://proplane.ai/rent/listings/4709a-8th-ave-ne");
    expect(buildManagerListingUrl("https://proplane.ai", "blank 1")).toBe("https://proplane.ai/rent/listings/blank%201");
  });
  it("JSON-LD carries the slug URL on the accommodation and its offer", () => {
    const ld = listingJsonLd({ ...A, rentLabel: "$900/mo" } as MockProperty, "https://proplane.ai", "4709a-8th-ave-ne") as { url: string; offers?: { url: string } };
    expect(ld.url).toBe("https://proplane.ai/rent/listings/4709a-8th-ave-ne");
    expect(ld.offers?.url).toBe("https://proplane.ai/rent/listings/4709a-8th-ave-ne");
    expect((listingJsonLd(A, "https://proplane.ai") as { url: string }).url).toBe(`https://proplane.ai/rent/listings/${encodeURIComponent(A.id)}`);
  });
  it("the sitemap and the listing page read the one slug module", () => {
    const sitemap = readFileSync(join(process.cwd(), "src/app/sitemap.ts"), "utf8");
    expect(sitemap).toContain("buildListingSlugIndex");
    expect(sitemap).not.toContain("encodeURIComponent(p.id)");
    const page = readFileSync(join(process.cwd(), "src/app/(rent)/rent/listings/[id]/page.tsx"), "utf8");
    expect(page).toContain("canonical");
    expect(page).not.toContain("permanentRedirect");
  });
});

describe("/rent/tour", () => {
  it("is a temporary redirect to /rent/tours-contact (never cached as a 308)", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toMatch(/source:\s*"\/rent\/tour",\s*destination:\s*"\/rent\/tours-contact",\s*permanent:\s*false/);
  });
});
