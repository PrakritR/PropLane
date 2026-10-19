/** Canonical public routes. The home page owns service, pricing and contact content. */
export const PUBLIC_MARKETING_PATHS = [
  "", "/about", "/security", "/vendors", "/partner", "/partner/pricing", "/partner/contact",
  "/privacy", "/tos", "/sms-terms", "/docs", "/docs/mcp", "/blog", "/rent/browse", "/app",
] as const;

export const MARKETING_REDIRECTS = [
  { source: "/pricing", destination: "/#pricing", statusCode: 308 },
  { source: "/pricing/service", destination: "/#service", statusCode: 308 },
  { source: "/service", destination: "/#service", statusCode: 308 },
  { source: "/why-proplane", destination: "/#service", statusCode: 308 },
  { source: "/why-proplane/:path+", destination: "/#service", statusCode: 308 },
  { source: "/contact", destination: "/#contact", statusCode: 308 },
  { source: "/features", destination: "/#dashboard", statusCode: 308 },
  { source: "/book-a-demo", destination: "/#contact", statusCode: 308 },
  { source: "/support", destination: "/#contact", statusCode: 308 },
  { source: "/reviews", destination: "/", statusCode: 308 },
];
