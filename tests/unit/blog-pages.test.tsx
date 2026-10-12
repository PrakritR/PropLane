import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import BlogIndexPage, { metadata as indexMetadata } from "@/app/(public)/blog/page";
import BlogPostPage, { generateMetadata, generateStaticParams } from "@/app/(public)/blog/[slug]/page";
import { BLOG_POSTS } from "@/lib/blog/posts";

const render = async (slug: string) =>
  renderToStaticMarkup(await BlogPostPage({ params: Promise.resolve({ slug }) }));

describe("blog pages", () => {
  it("prerenders one param per post and 404s anything else", async () => {
    expect(generateStaticParams()).toEqual(BLOG_POSTS.map((p) => ({ slug: p.slug })));
    await expect(render("not-a-post")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the index with a card per post", () => {
    const html = renderToStaticMarkup(BlogIndexPage());
    expect(html).toContain("The PropLane blog");
    for (const post of BLOG_POSTS) {
      expect(html).toContain(`href="/blog/${post.slug}"`);
      expect(html).toContain(post.category);
      expect(html).toContain(post.readMinutes + " min read");
    }
    expect(indexMetadata.title).toEqual({ absolute: "The PropLane blog" });
  });

  for (const post of BLOG_POSTS) {
    it(`renders ${post.slug}: stat tiles, body, sources, back link`, async () => {
      const html = await render(post.slug);
      expect(html).toContain("<h1");
      expect(html).toContain(post.category);
      for (const stat of post.stats) {
        expect(html).toContain(stat.value);
        expect(html).toContain(`href="#source-${stat.sourceIndex + 1}"`);
      }
      for (const section of post.sections) {
        if (section.heading) expect(html).toContain(section.heading.replace(/'/g, "&#x27;"));
      }
      post.sources.forEach((source, i) => {
        expect(html).toContain(`id="source-${i + 1}"`);
        expect(html).toContain(`href="${source.url}"`);
      });
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain('href="/blog"');
      // The one PropLane mention is a real link to the home page.
      expect(html).toMatch(/<a[^>]*href="\/"[^>]*>PropLane<\/a>/);
      expect(html).not.toContain("](/)");
    });

    it(`sets metadata for ${post.slug}`, async () => {
      const meta = await generateMetadata({ params: Promise.resolve({ slug: post.slug }) });
      expect(meta.title).toBe(post.title);
      expect(meta.description).toBe(post.description);
      expect(meta.alternates?.canonical).toBe(`/blog/${post.slug}`);
      expect(meta.openGraph).toMatchObject({ type: "article", title: post.title, publishedTime: post.date });
    });
  }
});
