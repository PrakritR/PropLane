/**
 * `/portal/owner/*` is retired: an owner of a PropLane-managed workspace uses the Property portal (the manager portal)
 * like everyone else. Every old owner URL (bookmarks, emailed statement links, texted approval links) is a permanent
 * redirect to its Property-portal home; the query string rides along (`workspace`, `month`, `review`, `approve`).
 * Read by `next.config.ts` so the redirect runs before any layout, and pinned by `tests/unit/owner-portal-routes.test.tsx`.
 */
export const OWNER_PORTAL_REDIRECTS: readonly { source: string; destination: string; permanent: true }[] = [
  { source: "/portal/owner", destination: "/portal/dashboard", permanent: true },
  { source: "/portal/owner/finances", destination: "/portal/financials/owner-payouts", permanent: true },
  { source: "/portal/owner/statements", destination: "/portal/financials/owner-statement", permanent: true },
  { source: "/portal/owner/statements/:month", destination: "/portal/financials/owner-statement?month=:month", permanent: true },
  { source: "/portal/owner/documents", destination: "/portal/documents", permanent: true },
  { source: "/portal/owner/messages", destination: "/portal/communication/active", permanent: true },
  { source: "/portal/owner/properties", destination: "/portal/properties", permanent: true },
  { source: "/portal/owner/properties/:propertyId", destination: "/portal/properties/all/:propertyId", permanent: true },
  { source: "/portal/owner/profile", destination: "/portal/profile", permanent: true },
  { source: "/portal/owner/:path*", destination: "/portal/dashboard", permanent: true },
];
