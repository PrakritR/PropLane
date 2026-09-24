import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import {
  isCanonicalPublicCrawlHost,
  requestHostFromHeaders,
} from "@/lib/seo/public-crawl-host";

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
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/portal/", "/resident/", "/vendor/", "/admin/", "/api/", "/auth/"],
    },
    sitemap: `${PRODUCTION_APP_ORIGIN}/sitemap.xml`,
    host: PRODUCTION_APP_ORIGIN,
  };
}
