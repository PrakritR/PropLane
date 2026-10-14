import type { MetadataRoute } from "next";
import { BLOG_POSTS } from "@/lib/blog/posts";
import { getPublicListings } from "@/lib/public-listings.server";

const BASE = "https://proplane.ai";

/** Public marketing URLs Google should index on the canonical host. */
const PATHS = [
  "",
  "/about",
  "/pricing",
  "/why-proplane",
  "/contact",
  "/book-a-demo",
  "/reviews",
  "/security",
  "/support",
  "/vendors",
  "/partner",
  "/partner/pricing",
  "/partner/contact",
  "/privacy",
  "/tos",
  "/sms-terms",
  "/docs",
  "/docs/mcp",
  "/blog",
  "/rent/browse",
  "/app",
] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const pages: MetadataRoute.Sitemap = PATHS.map((path) => ({
    url: path ? `${BASE}${path}` : `${BASE}/`,
    lastModified,
    changeFrequency: path === "" || path === "/pricing" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/pricing" || path === "/about" ? 0.9 : 0.6,
  }));
  // A post's own date may be ahead of today (the publish calendar is staggered); a `lastmod` in the future is
  // distrusted by crawlers, so the stamp is never later than now.
  const posts: MetadataRoute.Sitemap = BLOG_POSTS.map((post) => {
    const dated = Date.parse(`${post.date}T00:00:00Z`);
    return {
      url: `${BASE}/blog/${post.slug}`,
      lastModified: Number.isNaN(dated) ? lastModified : new Date(Math.min(dated, lastModified.getTime())),
      changeFrequency: "monthly",
      priority: 0.6,
    };
  });
  // Live public listings; a catalog failure must never break the sitemap.
  let listings: MetadataRoute.Sitemap = [];
  try {
    listings = (await getPublicListings()).map((p) => ({
      url: `${BASE}/rent/listings/${encodeURIComponent(p.id)}`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.7,
    }));
  } catch {
    /* sitemap still lists every static page */
  }
  return [...pages, ...posts, ...listings];
}
