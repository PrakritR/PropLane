import { describe, expect, it } from "vitest";
import { BLOG_POSTS, blogWordCount, formatBlogDate, getBlogPost } from "@/lib/blog/posts";

const bodyText = (post: (typeof BLOG_POSTS)[number]) =>
  post.sections.flatMap((s) => [s.heading ?? "", ...s.paragraphs]).join("\n");

describe("blog posts: data layer", () => {
  it("has five posts with unique slugs", () => {
    expect(BLOG_POSTS).toHaveLength(5);
    const slugs = BLOG_POSTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("is sorted newest first and dated 2026-10-12 or later", () => {
    const dates = BLOG_POSTS.map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const d of dates) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d >= "2026-10-12").toBe(true);
    }
    expect(formatBlogDate("2026-10-12")).toBe("October 12, 2026");
  });

  for (const post of BLOG_POSTS) {
    describe(post.slug, () => {
      it("has at least three sources, each with an https URL, a publisher and a year", () => {
        expect(post.sources.length).toBeGreaterThanOrEqual(3);
        for (const s of post.sources) {
          expect(s.url).toMatch(/^https:\/\//);
          expect(() => new URL(s.url)).not.toThrow();
          expect(s.title.length).toBeGreaterThan(0);
          expect(s.publisher.length).toBeGreaterThan(0);
          expect(s.year).toBeGreaterThanOrEqual(2019);
        }
        expect(new Set(post.sources.map((s) => s.url)).size).toBe(post.sources.length);
      });

      it("points every stat at a source with an https URL", () => {
        expect(post.stats.length).toBeGreaterThanOrEqual(3);
        for (const stat of post.stats) {
          expect(Number.isInteger(stat.sourceIndex)).toBe(true);
          const source = post.sources[stat.sourceIndex];
          expect(source, `${stat.value} sourceIndex`).toBeDefined();
          expect(source.url).toMatch(/^https:\/\//);
          expect(stat.value.length).toBeGreaterThan(0);
          expect(stat.label.length).toBeGreaterThan(0);
        }
      });

      it("is 900 to 1,300 words and ends on a practical section", () => {
        const words = blogWordCount(post);
        expect(words).toBeGreaterThanOrEqual(900);
        expect(words).toBeLessThanOrEqual(1300);
        expect(post.sections.at(-1)?.heading).toBe("What to do about it");
      });

      it("keeps the voice rules", () => {
        const text = bodyText(post);
        const all = `${post.title} ${post.description} ${text}`;
        expect(all).not.toContain("!");
        expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(all).not.toMatch(/work order/i);
        expect(all).not.toMatch(/research shows/i);
        // 2024 Rental Housing Finance Survey figures are deliberately not used.
        expect(all).not.toMatch(/\b59%/);
        expect(all).not.toMatch(/\b72\.5/);
        // No stat is attributed to NARPM that NARPM did not publish.
        expect(all).not.toMatch(/NARPM[^.]*8\s?(-|to|–)\s?12/i);
        expect(all).not.toMatch(/8\s?(-|to|–)\s?12\s?%[^.]*NARPM/i);
        expect(post.readMinutes).toBeGreaterThan(0);
        expect(post.description.length).toBeLessThanOrEqual(200);
      });

      it("mentions PropLane at most once, in the last section, linked to /", () => {
        const mentions = post.sections.flatMap((s, si) =>
          s.paragraphs.filter((p) => p.includes("PropLane")).map(() => si),
        );
        expect(mentions.length).toBeLessThanOrEqual(1);
        for (const si of mentions) expect(si).toBe(post.sections.length - 1);
        const body = bodyText(post);
        expect(body.match(/PropLane/g)?.length ?? 0).toBeLessThanOrEqual(1);
        if (body.includes("PropLane")) expect(body).toContain("[PropLane](/)");
        // The only inline markup is an internal link.
        const links = [...body.matchAll(/\[[^\]]+\]\(([^)]*)\)/g)].map((m) => m[1]);
        for (const href of links) expect(href).toBe("/");
      });

      it("is found by slug", () => {
        expect(getBlogPost(post.slug)).toBe(post);
      });
    });
  }
});
