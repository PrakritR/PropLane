/**
 * One hourly public-catalog read feeds both crawl surfaces.
 *
 * `/sitemap.xml` advertises every listing URL, so a crawler walks the sitemap and then each
 * `/rent/listings/<id>` page. Both read the catalog through `getCrawlPublicListings`, and the
 * memo is what keeps that crawl from paying `getPublicListings()` once per URL.
 */
import { listingCanonicalSlug } from "@/lib/listing-slug";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  count: 0,
  fail: false,
  gate: null as Promise<void> | null,
  /** Listings the catalog answers with RIGHT NOW: a publish between two reads is this list growing. */
  extra: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: async () => {
    reads.count += 1;
    if (reads.fail) throw new Error("catalog unavailable");
    if (reads.gate) await reads.gate;
    return [
      {
        id: "listing-1",
        title: "Room 1 · 4709A 8th Ave NE",
        address: "4709A 8th Ave NE",
        zip: "98105",
        rentLabel: "$1,100/mo",
        available: "Now",
        buildingId: "b-1",
        buildingName: "4709A 8th Ave NE",
        unitLabel: "Room 1",
      },
      ...reads.extra,
    ];
  },
}));

/** The one indexed read that resolves a slug's id token when the catalog index cannot. */
const db = vi.hoisted(() => ({
  queries: [] as Record<string, unknown>[],
  rows: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const query: Record<string, unknown> = { table };
      db.queries.push(query);
      const answer = () =>
        db.fail ? { data: null, error: { message: "records unavailable" } } : { data: db.rows, error: null };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((query.select = columns), builder),
        eq: (column: string, value: unknown) => ((query[`eq:${column}`] = value), builder),
        is: (column: string, value: unknown) => ((query[`is:${column}`] = value), builder),
        ilike: (column: string, value: unknown) => ((query[`ilike:${column}`] = value), builder),
        limit: (rows: number) => ((query.limit = rows), builder),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(answer()).then(resolve),
      };
      return builder;
    },
  }),
}));

afterEach(async () => {
  const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
  const { resetListingSlugIndexRefresh } = await import("@/lib/seo/listing-slugs.server");
  resetCrawlPublicListingsCache();
  resetListingSlugIndexRefresh();
  reads.count = 0;
  reads.fail = false;
  reads.gate = null;
  reads.extra = [];
  db.queries.length = 0;
  db.rows = [];
  db.fail = false;
});

const SLUG = listingCanonicalSlug({ id: "listing-1", address: "4709A 8th Ave NE" });

describe("the crawl catalog is read once per hour, not once per URL", () => {
  it("serves the sitemap and the listing pages a crawler walks from it on one read", async () => {
    const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    const sitemap = (await import("@/app/sitemap")).default;
    const page = (await import("@/app/(rent)/rent/listings/[id]/page")).default;

    const entries = await sitemap();
    expect(entries.some((e) => e.url.endsWith(`/rent/listings/${SLUG}`))).toBe(true);
    expect(reads.count).toBe(1);

    // The crawler then walks the listing URLs the sitemap just handed it.
    for (let i = 0; i < 3; i += 1) {
      const tree = (await page({ params: Promise.resolve({ id: SLUG }) })) as {
        props: { children: { props?: { dangerouslySetInnerHTML?: { __html: string } } }[] };
      };
      const script = tree.props.children.find((child) => child?.props?.dangerouslySetInnerHTML);
      expect(JSON.parse(script!.props!.dangerouslySetInnerHTML!.__html)["@type"]).toBe("Accommodation");
    }
    expect(reads.count).toBe(1);
  });

  it("renders an old id URL in place (its query survives) and declares the readable address URL canonical, on the same read", async () => {
    const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    const mod = await import("@/app/(rent)/rent/listings/[id]/page");
    const tree = await mod.default({ params: Promise.resolve({ id: "listing-1" }) });
    expect(tree).toBeTruthy();
    const meta = await mod.generateMetadata({ params: Promise.resolve({ id: "listing-1" }) });
    expect(String(meta.alternates?.canonical ?? "")).toMatch(new RegExp(`/rent/listings/${SLUG}$`));
    expect(reads.count).toBe(1);
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const { getCrawlPublicListings, resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    const all = await Promise.all([getCrawlPublicListings(), getCrawlPublicListings(), getCrawlPublicListings()]);
    expect(reads.count).toBe(1);
    expect(all[0]).toBe(all[2]);
  });

  it("never caches a failure: the next caller retries and the sitemap still lists every static page", async () => {
    const { getCrawlPublicListings, resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    reads.fail = true;
    const sitemap = (await import("@/app/sitemap")).default;
    const entries = await sitemap();
    expect(entries.some((e) => e.url === "https://proplane.ai/")).toBe(true);
    expect(entries.some((e) => e.url.includes("/rent/listings/"))).toBe(false);

    reads.fail = false;
    expect((await getCrawlPublicListings()).length).toBe(1);
    expect(reads.count).toBe(2);
  });

  /**
   * `/sitemap.xml` is prerendered, and Next fails the build when one route takes more than 60
   * seconds — so a catalog read that stalls instead of answering must not be waited on. Every
   * retry of the route joins the same in-flight read, which is how one stalled read failed all
   * three of Next's attempts and the build with them.
   */
  it("gives up on a stalled read, and still fills the memo when that read lands", async () => {
    vi.useFakeTimers();
    try {
      const { CRAWL_CATALOG_WAIT_MS, getCrawlPublicListings, resetCrawlPublicListingsCache } = await import(
        "@/lib/seo/public-catalog.server"
      );
      resetCrawlPublicListingsCache();
      let release = () => {};
      reads.gate = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const sitemap = (await import("@/app/sitemap")).default;

      const pending = sitemap();
      await vi.advanceTimersByTimeAsync(CRAWL_CATALOG_WAIT_MS);
      const entries = await pending;
      expect(entries.some((e) => e.url === "https://proplane.ai/")).toBe(true);
      expect(entries.some((e) => e.url.includes("/rent/listings/"))).toBe(false);

      // Giving up is not cancelling: the read keeps going, and the next caller pays nothing for it.
      reads.gate = null;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect((await getCrawlPublicListings()).length).toBe(1);
      expect(reads.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * A slug URL is durable: texted, syndicated, shared, indexed. It may not stop resolving because the HOURLY catalog
 * read is slow, failed, or did not return that listing's row — a page that answers "Listing not found" while the
 * home is live gets that answer cached for the hour (`revalidate = 3600`).
 *
 * Oracle: the published slug form (`listingCanonicalSlug`, the same builder the sitemap and every link printer use)
 * over the record the live-records read names. Plausible wrong behaviour this rejects: handing the client the slug
 * string as a property id, which is what the catalog-only resolution did whenever the index was empty.
 */
describe("a canonical slug resolves without the catalog index", () => {
  const MINTED_ID = "mgr-4709a-8th-ave-7mdlyj0h2vfg";
  const MINTED_SLUG = listingCanonicalSlug({ id: MINTED_ID, address: "4709A 8th Ave NE" });
  const liveRow = { id: MINTED_ID, property_data: { id: MINTED_ID, address: "4709A 8th Ave NE" } };

  const clientListingId = async (param: string) => {
    const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    const tree = (await (await import("@/app/(rent)/rent/listings/[id]/page")).default({
      params: Promise.resolve({ id: param }),
    })) as { props: { children: { props?: Record<string, unknown> }[] } };
    const client = tree.props.children.find((child) => child?.props && "listingId" in child.props);
    return client?.props?.listingId;
  };

  /** The page as a later visitor gets it: the instance's own memo stands, exactly as it would in production. */
  const listingIdFromPage = async (param: string) => {
    const tree = (await (await import("@/app/(rent)/rent/listings/[id]/page")).default({
      params: Promise.resolve({ id: param }),
    })) as { props: { children: { props?: Record<string, unknown> }[] } };
    const client = tree.props.children.find((child) => child?.props && "listingId" in child.props);
    return client?.props?.listingId;
  };

  const PUBLISHED_ID = "mgr-5257-brooklyn-ave-1x3tiu8k2mnq";
  const PUBLISHED_SLUG = listingCanonicalSlug({ id: PUBLISHED_ID, address: "5257 Brooklyn Ave NE" });
  const publish = () => {
    reads.extra = [{
      id: PUBLISHED_ID,
      title: "Room 1 · 5257 Brooklyn Ave NE",
      address: "5257 Brooklyn Ave NE",
      zip: "98105",
      rentLabel: "$1,200/mo",
      available: "Now",
      buildingId: "b-2",
      buildingName: "5257 Brooklyn Ave NE",
      unitLabel: "Room 1",
    }];
  };

  /*
   * The memo is an HOUR long, so a listing published at 10:00 is missing from an instance whose memo filled at
   * 09:30 - and every link builder mints that listing's canonical slug from the listing in hand, with no reference
   * to the index. Oracle: `listingCanonicalSlug`, the builder the sitemap and every link printer use. Plausible
   * wrong behaviour this rejects: handing the client the slug string, so a live home reads "Listing not found" -
   * ISR-cached for the hour, outliving the memo that caused it.
   */
  it("resolves a listing published since the memoized catalog read, on one refresh", async () => {
    const { getCrawlPublicListings } = await import("@/lib/seo/public-catalog.server");
    await getCrawlPublicListings();
    expect(reads.count).toBe(1);
    publish();

    expect(await listingIdFromPage(PUBLISHED_SLUG)).toBe(PUBLISHED_ID);
    expect(reads.count).toBe(2);
    // The refreshed index answered, so the property table was never scanned.
    expect(db.queries).toEqual([]);
  });

  it("buys at most one refresh a minute, whatever arrives", async () => {
    const { getCrawlPublicListings } = await import("@/lib/seo/public-catalog.server");
    await getCrawlPublicListings();
    publish();

    for (const param of ["a-abcd1234", "b-efgh5678", PUBLISHED_SLUG, "c-ijkl9012"]) {
      await listingIdFromPage(param);
    }
    expect(reads.count).toBe(2);
    expect(await listingIdFromPage("d-mnop3456")).toBe("d-mnop3456");
    expect(reads.count).toBe(2);
    expect(db.queries).toEqual([]);
  });

  it("names the listing, and its canonical URL, when the catalog read fails", async () => {
    reads.fail = true;
    db.rows = [liveRow];
    expect(await clientListingId(MINTED_SLUG)).toBe(MINTED_ID);
    const meta = await (await import("@/app/(rent)/rent/listings/[id]/page")).generateMetadata({
      params: Promise.resolve({ id: MINTED_SLUG }),
    });
    expect(String(meta.alternates?.canonical ?? "")).toMatch(new RegExp(`/rent/listings/${MINTED_SLUG}$`));
    // Live, public, and one row: a draft, a test-workspace copy or a shared token must never answer.
    const query = db.queries[0]!;
    expect(query).toMatchObject({
      table: "manager_property_records",
      "eq:status": "live",
      "is:test_workspace_id": null,
      "ilike:id": `%-7mdlyj0h2vfg`,
      limit: 2,
    });
  });

  it("keeps the not-found state for a token no single live listing owns", async () => {
    reads.fail = true;
    db.rows = [];
    expect(await clientListingId(MINTED_SLUG)).toBe(MINTED_SLUG);
    db.rows = [liveRow, { id: "other-7mdlyj0h2vfg", property_data: { id: "other-7mdlyj0h2vfg", address: "1 A St" } }];
    expect(await clientListingId(MINTED_SLUG)).toBe(MINTED_SLUG);
    db.fail = true;
    expect(await clientListingId(MINTED_SLUG)).toBe(MINTED_SLUG);
  });

  /*
   * A trailing match on the id can use no index, so this read is a scan of the property table. It belongs to the
   * outage and nothing else: a readable index that simply does not know a param is a not-found answer, and the page
   * is public, unauthenticated and ISR-keyed per path, so unlimited junk params must not each buy a scan.
   */
  it("is not read for an unknown param while the index is readable, nor without a minted id token", async () => {
    db.rows = [liveRow];
    expect(await clientListingId(SLUG)).toBe("listing-1");
    expect(await clientListingId("x-abcd1234")).toBe("x-abcd1234");
    expect(await clientListingId(MINTED_SLUG)).toBe(MINTED_SLUG);
    expect(db.queries).toEqual([]);
    reads.fail = true;
    expect(await clientListingId("4709a-8th-ave-ne")).toBe("4709a-8th-ave-ne");
    expect(db.queries).toEqual([]);
  });
});
