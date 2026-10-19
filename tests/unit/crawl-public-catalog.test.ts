/**
 * One hourly public-catalog read feeds both crawl surfaces.
 *
 * `/sitemap.xml` advertises every listing URL, so a crawler walks the sitemap and then each
 * `/rent/listings/<id>` page. Both read the catalog through `getCrawlPublicListings`, and the
 * memo is what keeps that crawl from paying `getPublicListings()` once per URL.
 */
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

afterEach(async () => {
  const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
  resetCrawlPublicListingsCache();
  reads.count = 0;
  reads.fail = false;
  reads.gate = null;
});

describe("the crawl catalog is read once per hour, not once per URL", () => {
  it("serves the sitemap and the listing pages a crawler walks from it on one read", async () => {
    const { resetCrawlPublicListingsCache } = await import("@/lib/seo/public-catalog.server");
    resetCrawlPublicListingsCache();
    const sitemap = (await import("@/app/sitemap")).default;
    const page = (await import("@/app/(public)/rent/listings/[id]/page")).default;

    const entries = await sitemap();
    expect(entries.some((e) => e.url.endsWith("/rent/listings/listing-1"))).toBe(true);
    expect(reads.count).toBe(1);

    // The crawler then walks the listing URLs the sitemap just handed it.
    for (let i = 0; i < 3; i += 1) {
      const tree = (await page({ params: Promise.resolve({ id: "listing-1" }) })) as {
        props: { children: { props?: { dangerouslySetInnerHTML?: { __html: string } } }[] };
      };
      const script = tree.props.children.find((child) => child?.props?.dangerouslySetInnerHTML);
      expect(JSON.parse(script!.props!.dangerouslySetInnerHTML!.__html)["@type"]).toBe("Accommodation");
    }
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
