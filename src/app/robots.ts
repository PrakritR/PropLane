import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/portal/", "/resident/", "/vendor/", "/admin/", "/api/", "/auth/"],
    },
    sitemap: "https://proplane.ai/sitemap.xml",
    host: "https://proplane.ai",
  };
}
