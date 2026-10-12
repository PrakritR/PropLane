import type { MetadataRoute } from "next";
import { BLOG_POSTS } from "@/lib/blog/posts";

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

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const pages: MetadataRoute.Sitemap = PATHS.map((path) => ({
    url: path ? `${BASE}${path}` : `${BASE}/`,
    lastModified,
    changeFrequency: path === "" || path === "/pricing" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/pricing" || path === "/about" ? 0.9 : 0.6,
  }));
  const posts: MetadataRoute.Sitemap = BLOG_POSTS.map((post) => ({
    url: `${BASE}/blog/${post.slug}`,
    lastModified: new Date(`${post.date}T00:00:00Z`),
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  return [...pages, ...posts];
}
