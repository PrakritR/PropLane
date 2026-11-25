/**
 * One hourly public-catalog read feeds both crawl surfaces.
 *
 * `/sitemap.xml` advertises every listing URL, so a crawler walks the sitemap and then each
 * `/rent/listings/<id>` page. Both read the catalog through `getCrawlPublicListings`, and the
 * memo is what keeps that crawl from paying `getPublicListings()` once per URL.
 */
import { listingCanonicalSlug } from "@/lib/listing-slug";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ count: 0, fail: false, gate: null as Promise<void> | null }));

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
  resetCrawlPublicListingsCache();
  reads.count = 0;
  reads.fail = false;
  reads.gate = null;
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

  it("is not read at all when the index answers, nor for a param carrying no minted id token", async () => {
    db.rows = [liveRow];
    expect(await clientListingId(SLUG)).toBe("listing-1");
    expect(db.queries).toEqual([]);
    reads.fail = true;
    expect(await clientListingId("4709a-8th-ave-ne")).toBe("4709a-8th-ave-ne");
    expect(db.queries).toEqual([]);
  });
});
