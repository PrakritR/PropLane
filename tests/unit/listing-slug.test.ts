import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
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
  it("a slug published before the id token (the bare street line) still resolves, to the canonical URL", () => {
    expect(resolveListingParam(index, "4709a-8th-ave-ne")).toEqual({ kind: "redirect", slug: slugA, id: A.id });
    expect(resolveListingParam(index, "4709A-8th-Ave-NE")).toEqual({ kind: "redirect", slug: slugA, id: A.id });
  });

  // The pre-token scheme (b83f959 `buildListingSlugIndex` + `listingIdSuffix`) published ONE form per listing: the bare
  // street line for a listing that owned it alone, and `<street>-<last six characters of the id>` for each listing in a
  // group that shared one. Whichever form a listing went out under in the sitemap, texts and syndicated posts resolves;
  // a form it never had does not.
  it("a legacy base slug two listings share names neither, but each one's published suffix form resolves", () => {
    const twin = home("prop-twin-aaaa1111zz", "4709A 8th Ave NE, Seattle, WA");
    const shared = buildListingSlugIndex([A, twin]);
    expect(resolveListingParam(shared, "4709a-8th-ave-ne")).toEqual({ kind: "id", id: "4709a-8th-ave-ne" });
    expect(resolveListingParam(shared, `4709a-8th-ave-ne-${A.id.slice(-6)}`)).toMatchObject({ kind: "redirect", id: A.id });
    expect(resolveListingParam(shared, `4709a-8th-ave-ne-${twin.id.slice(-6)}`)).toMatchObject({ kind: "redirect", id: twin.id });
  });

  it("accepts no suffix form for a listing that owned its street line alone: that URL was never published", () => {
    const param = `4709a-8th-ave-ne-${A.id.slice(-6)}`;
    expect(resolveListingParam(index, param)).toEqual({ kind: "id", id: param });
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
});

describe("the middleware sends an old record-id URL to the canonical one", () => {
  // Oracle: RFC 7538 — a 308 names the resource's new location and the client repeats the request there, so the
  // query a listing link carries (`?stay=1`, `?src=`) must survive the hop. The canonical slug itself comes from
  // this module. Wrong behaviours this rejects: no redirect at all, or a Location with the query dropped.
  it("answers 308 with the canonical path and keeps the query", async () => {
    const { middleware } = await import("@/middleware");
    const slug = "4709a-8th-ave-ne-7mdlyj0h2vfg";
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify({ slug }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      const res = await middleware(
        new NextRequest(`https://proplane.ai/rent/listings/${encodeURIComponent(A.id)}?stay=1&src=zillow`, { method: "GET" }),
      );
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`https://proplane.ai/rent/listings/${slug}?stay=1&src=zillow`);
      expect(asked.some((url) => url.includes("/api/public/listing-canonical") && url.includes(encodeURIComponent(A.id)))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("renders in place when the canonical lookup fails", async () => {
    const { middleware } = await import("@/middleware");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    try {
      const res = await middleware(new NextRequest(`https://proplane.ai/rent/listings/${A.id}`, { method: "GET" }));
      expect(res.status).not.toBe(308);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The tour doors are decided by `redirects()` in `next.config.ts`, which Next evaluates IN ORDER and whose
// `missing` entries it ANDs. The matcher below is that contract applied to the real exported list: every rule
// under test names a literal path, so a literal compare is the whole of Next's matching for these requests, and
// a rule applies only when every `missing` query key is absent. A parameterised source that could reach one of
// these paths is not something a literal compare may silently skip, so the matcher refuses to guess.
// Oracle: Next.js routing (`redirects` ordering + `missing`) and RFC 7538 for `permanent: false` meaning 307.
// Wrong behaviours this rejects: a bare /rent/tour landing on the dead-end contact form, a request that NAMES a
// home being bounced to the browse picker, and any of these rules being minted permanent so a browser caches it.
type RedirectRule = {
  source: string;
  destination: string;
  permanent?: boolean;
  missing?: { type: string; key?: string }[];
  has?: { type: string; key?: string }[];
};

function firstRedirect(rules: RedirectRule[], pathname: string, query: Record<string, string> = {}) {
  return rules.find((rule) => {
    const parameter = rule.source.indexOf(":");
    if (parameter >= 0) {
      if (pathname.startsWith(rule.source.slice(0, parameter))) {
        throw new Error(`"${rule.source}" may match ${pathname}; teach this matcher the pattern before trusting it`);
      }
      return false;
    }
    if (rule.source !== pathname) return false;
    const absent = (entry: { type: string; key?: string }) => entry.type === "query" && !(String(entry.key) in query);
    if (!(rule.missing ?? []).every(absent)) return false;
    return (rule.has ?? []).every((entry) => !absent(entry));
  });
}

describe("the tour and message doors", () => {
  let rules: RedirectRule[] = [];
  beforeAll(async () => {
    const config = (await import("../../next.config")).default;
    rules = (await config.redirects!()) as RedirectRule[];
  });

  it("sends a request that names no home to the browse picker, temporarily", () => {
    for (const path of ["/rent/tour", "/rent/tours", "/rent/tours-contact"]) {
      expect(firstRedirect(rules, path), path).toMatchObject({ destination: "/rent/browse", permanent: false });
    }
  });

  it("keeps a request that names a home, a share list, a sign-in return or a filed inquiry", () => {
    expect(firstRedirect(rules, "/rent/tour", { propertyId: "prop-1" })).toMatchObject({
      destination: "/rent/tours-contact",
      permanent: false,
    });
    expect(firstRedirect(rules, "/rent/tours", { ids: "prop-1,prop-2" })).toBeUndefined();
    expect(firstRedirect(rules, "/rent/tours-contact", { tourInquiryId: "ti-1" })).toBeUndefined();
    expect(firstRedirect(rules, "/rent/tours-contact", { next: "/resident/applications" })).toBeUndefined();
  });
});
