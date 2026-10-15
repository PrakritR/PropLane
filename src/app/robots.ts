import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import {
  isCanonicalPublicCrawlHost,
  requestHostFromHeaders,
} from "@/lib/seo/public-crawl-host";

export const PRIVATE_PATHS = ["/portal/", "/resident/", "/vendor/", "/admin/", "/api/", "/auth/", "/invite/", "/mcp/"];

export const AI_CRAWLERS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
] as const;

/**
 * Staging / preview / localhost must not invite crawlers. Production marketing
 * stays open; portal surfaces stay disallowed.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = requestHostFromHeaders(await headers());
  if (!isCanonicalPublicCrawlHost(host)) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      // AI assistants and AI search: named so the intent is explicit and survives a future `*` change.
      { userAgent: [...AI_CRAWLERS], allow: "/", disallow: PRIVATE_PATHS },
    ],
    sitemap: `${PRODUCTION_APP_ORIGIN}/sitemap.xml`,
    host: PRODUCTION_APP_ORIGIN,
  };
}
