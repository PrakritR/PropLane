/** Canonical public routes. The home page owns service, pricing and contact content. */
export const PUBLIC_MARKETING_PATHS = [
  "", "/about", "/security", "/vendors", "/partner", "/partner/pricing", "/partner/contact",
  "/privacy", "/tos", "/sms-terms", "/docs", "/docs/mcp", "/blog", "/rent/browse", "/app",
] as const;

/**
 * The home page owns this content now and the pages these shadow are deleted. TEMPORARY (307) on purpose: a 308
 * is cached hard by browsers and search engines, so a later decision to give any of these its own page again
 * would not reach anyone who had already followed the redirect.
 */
export const MARKETING_REDIRECTS = [
  { source: "/pricing", destination: "/#pricing", statusCode: 307 },
  { source: "/pricing/service", destination: "/#service", statusCode: 307 },
  { source: "/service", destination: "/#service", statusCode: 307 },
  { source: "/why-proplane", destination: "/#service", statusCode: 307 },
  { source: "/why-proplane/:path+", destination: "/#service", statusCode: 307 },
  { source: "/contact", destination: "/#contact", statusCode: 307 },
  { source: "/features", destination: "/#dashboard", statusCode: 307 },
  { source: "/book-a-demo", destination: "/#contact", statusCode: 307 },
  { source: "/support", destination: "/#contact", statusCode: 307 },
  { source: "/reviews", destination: "/", statusCode: 307 },
];
