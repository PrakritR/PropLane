import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: async () => [{ id: "prop-1" }, { id: "prop-2" }],
}));

import sitemap from "@/app/sitemap";
import { BLOG_POSTS } from "@/lib/blog/posts";

describe("blog in the sitemap", () => {
  let urls: string[] = [];
  beforeAll(async () => {
    urls = (await sitemap()).map((e) => e.url);
  });

  it("lists the blog index", () => {
    expect(urls).toContain("https://proplane.ai/blog");
  });

  it("lists every post exactly once", () => {
    for (const post of BLOG_POSTS) {
      expect(urls.filter((u) => u === `https://proplane.ai/blog/${post.slug}`)).toHaveLength(1);
    }
  });

  it("lists live public listings", () => {
    expect(urls).toContain("https://proplane.ai/rent/listings/prop-1");
    expect(urls).toContain("https://proplane.ai/rent/listings/prop-2");
  });

  it("has no duplicate URLs", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });
});
