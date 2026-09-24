import { describe, expect, it } from "vitest";
import {
  isCanonicalPublicCrawlHost,
  normalizeCrawlHostname,
  NOINDEX_ROBOTS_TAG,
  requestHostFromHeaders,
} from "@/lib/seo/public-crawl-host";

describe("public crawl host", () => {
  it("normalizes ports, case, and multi-value forwarded hosts", () => {
    expect(normalizeCrawlHostname("ProPlane.AI:443")).toBe("proplane.ai");
    expect(normalizeCrawlHostname("staging-prop-lane.space, other.example")).toBe(
      "staging-prop-lane.space",
    );
  });

  it("allows only apex and www for indexing", () => {
    expect(isCanonicalPublicCrawlHost("proplane.ai")).toBe(true);
    expect(isCanonicalPublicCrawlHost("www.proplane.ai")).toBe(true);
    expect(isCanonicalPublicCrawlHost("PROPLANE.AI")).toBe(true);
    expect(isCanonicalPublicCrawlHost("staging-prop-lane.space")).toBe(false);
    expect(isCanonicalPublicCrawlHost("prop-lane.space")).toBe(false);
    expect(isCanonicalPublicCrawlHost("www.axis-seattle-housing.com")).toBe(false);
    expect(isCanonicalPublicCrawlHost("axis-2-git-staging-foo.vercel.app")).toBe(false);
    expect(isCanonicalPublicCrawlHost("localhost")).toBe(false);
    expect(isCanonicalPublicCrawlHost("localhost:3004")).toBe(false);
    expect(isCanonicalPublicCrawlHost("")).toBe(false);
  });

  it("prefers x-forwarded-host over host", () => {
    const headers = new Headers({
      host: "localhost:3004",
      "x-forwarded-host": "staging-prop-lane.space",
    });
    expect(requestHostFromHeaders(headers)).toBe("staging-prop-lane.space");
  });

  it("exports the noindex tag crawlers expect", () => {
    expect(NOINDEX_ROBOTS_TAG).toBe("noindex, nofollow");
  });
});
