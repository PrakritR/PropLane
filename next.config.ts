import type { NextConfig } from "next";
import { networkInterfaces } from "os";

function localLanHosts(): string[] {
  const hosts = new Set<string>();
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) hosts.add(addr.address);
    }
  }
  return [...hosts];
}

function capacitorDevOrigins(): string[] {
  const origins = new Set<string>(["127.0.0.1", "localhost"]);
  if (process.env.NODE_ENV === "development") {
    for (const host of localLanHosts()) origins.add(host);
  }
  const capServer = process.env.CAP_SERVER_URL?.trim();
  if (capServer) {
    try {
      origins.add(new URL(capServer).hostname);
    } catch {
      /* ignore */
    }
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  env: {
    // Baked at build time — keeps SSR and client in sync for demo gating. Default on;
    // set NEXT_PUBLIC_AXIS_PUBLIC_DEMO_ENABLED=false in Vercel to hide /demo surfaces.
    NEXT_PUBLIC_AXIS_PUBLIC_DEMO_ENABLED: process.env.NEXT_PUBLIC_AXIS_PUBLIC_DEMO_ENABLED ?? "true",
    NEXT_PUBLIC_DEMO_SUPABASE_URL: process.env.NEXT_PUBLIC_DEMO_SUPABASE_URL ?? "",
    NEXT_PUBLIC_DEMO_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_DEMO_SUPABASE_ANON_KEY ?? "",
    // Primary Supabase project — explicit pass-through so Turbopack client bundles
    // always inline these even when .env.local was added after a cached dev compile.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  },
  // Lets the iOS/Android WebView load from your Mac's LAN IP during `npm run dev`.
  allowedDevOrigins: capacitorDevOrigins(),
  skipTrailingSlashRedirect: true,
  experimental: {
    // Persist Turbopack compiler output between dev restarts — faster cold starts.
    turbopackFileSystemCacheForDev: true,
    optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  images: {
    remotePatterns: [
      // Supabase Storage (all hosted projects)
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
      // Unsplash fallback photos on listing cards
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/auth/login", destination: "/auth/sign-in", permanent: false },
      { source: "/dashboard", destination: "/auth/continue", permanent: false },
      { source: "/admin/applications", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/applications/:path*", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/work-orders", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/work-orders/:path*", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/payments", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/payments/:path*", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/announcements", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/announcements/:path*", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/calendar", destination: "/admin/events", permanent: false },
      { source: "/admin/calendar/week", destination: "/admin/events", permanent: false },
      { source: "/admin/calendar/availability", destination: "/admin/events", permanent: false },
      { source: "/admin/events/events", destination: "/admin/events", permanent: false },
      { source: "/admin/events/availability", destination: "/admin/events", permanent: false },
      { source: "/admin/leasing", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/leasing/:path*", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/leases", destination: "/admin/dashboard", permanent: false },
      { source: "/admin/leases/:path*", destination: "/admin/dashboard", permanent: false },
      // NOTE: do NOT redirect /admin/bugs-feedback — "Feedback" is a live admin nav
      // section (portals/admin.ts) rendered by AdminBugFeedbackClient. A legacy
      // redirect here shadows the route before it ever reaches the app router.
      { source: "/admin/bugs-feedback/:path+", destination: "/admin/bugs-feedback", permanent: false },
      // Legacy resident "home"/"properties" section was renamed away (the resident
      // portal now has dashboard + move-in "House details"; there is no `properties`
      // section in resident-sections.ts). Point these at the real resident home so an
      // old bookmark lands on the dashboard instead of a 404, matching the sibling
      // /resident/announcements and /resident/support legacy redirects below.
      { source: "/resident/home", destination: "/resident/dashboard", permanent: false },
      { source: "/resident/home/:path*", destination: "/resident/dashboard", permanent: false },
      // /resident/lease is the standalone interactive Lease section (resident-sections.ts,
      // ResidentLeasePanel) — never redirect it; the read-only signed-lease
      // document lives at /resident/documents/lease.
      { source: "/resident/leases", destination: "/resident/lease", permanent: false },
      { source: "/resident/leases/:path*", destination: "/resident/lease", permanent: false },
      { source: "/resident/announcements", destination: "/resident/dashboard", permanent: false },
      { source: "/resident/announcements/:path*", destination: "/resident/dashboard", permanent: false },
      { source: "/resident/settings", destination: "/resident/profile", permanent: false },
      { source: "/resident/settings/:path*", destination: "/resident/profile", permanent: false },
      { source: "/portal/settings", destination: "/portal/profile", permanent: false },
      { source: "/portal/settings/:path*", destination: "/portal/profile", permanent: false },
      { source: "/admin/settings", destination: "/admin/profile", permanent: false },
      { source: "/admin/settings/:path*", destination: "/admin/profile", permanent: false },
      { source: "/resident/support", destination: "/resident/dashboard", permanent: false },
      { source: "/resident/support/:path*", destination: "/resident/dashboard", permanent: false },
      { source: "/portal/services/work-done", destination: "/portal/financials/expenses", permanent: false },
      { source: "/portal/services/work-done/:path*", destination: "/portal/financials/expenses", permanent: false },
      { source: "/portal/work-orders", destination: "/portal/services/work-orders", permanent: false },
      { source: "/portal/work-orders/:path*", destination: "/portal/services/work-orders", permanent: false },
    ];
  },
};

export default nextConfig;
