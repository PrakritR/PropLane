import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { BLOG_POSTS } from "@/lib/blog/posts";

describe("blog in the sitemap", () => {
  const urls = sitemap().map((e) => e.url);

  it("lists the blog index", () => {
    expect(urls).toContain("https://proplane.ai/blog");
  });

  it("lists every post exactly once", () => {
    for (const post of BLOG_POSTS) {
      expect(urls.filter((u) => u === `https://proplane.ai/blog/${post.slug}`)).toHaveLength(1);
    }
  });

  it("has no duplicate URLs", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });
});
