function trimOrigin(url: string | undefined): string {
  return url?.trim().replace(/\/$/, "") ?? "";
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
}

function isVercelDeploymentHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".vercel.app");
}

/** Legacy Axis Seattle domains — never emit in outbound email or shareable links. */
function isLegacyAxisProductionHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "axis-seattle-housing.com" || host === "www.axis-seattle-housing.com";
}

function isUsableEmailLinkHost(hostname: string): boolean {
  return !isVercelDeploymentHost(hostname) && !isLegacyAxisProductionHost(hostname);
}

/** Canonical, user-facing production domain — the only host outbound emails link to. */
export const PRODUCTION_APP_ORIGIN = "https://prop-lane.space";

/** Live web origins that serve the same Vercel deployment (multi-domain production). */
const DEFAULT_PRODUCTION_WEB_ORIGINS = [
  PRODUCTION_APP_ORIGIN,
  "https://www.prop-lane.space",
  "https://axis-seattle-housing.com",
  "https://www.axis-seattle-housing.com",
] as const;

/**
 * Is an ENV-supplied origin actually a live production web origin?
 *
 * `NEXT_PUBLIC_APP_URL` is documented as `http://localhost:3000` for local dev
 * (`.env.example`, SUPABASE_STRIPE_SETUP.md §3), so taking it on trust made
 * `isKnownProductionWebHost("localhost")` true on every dev box — which makes
 * `isProductionPublicSite()` true and quietly filters sandbox listings out of
 * the local rent catalog. A preview deploy has the same problem via
 * `*.vercel.app`. Neither is ever a production web origin, so neither belongs
 * in this list no matter what the environment says.
 */
function envOriginIsProductionWebOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return !isLocalHost(hostname) && !isVercelDeploymentHost(hostname);
  } catch {
    return false;
  }
}

/** Every production HTTPS origin managers may open — used for OAuth allowlist docs and redirect resolution. */
export function knownProductionWebOrigins(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const fromEnv = [
    trimOrigin(process.env.NEXT_PUBLIC_CANONICAL_APP_URL),
    trimOrigin(process.env.NEXT_PUBLIC_APP_URL),
  ].filter(envOriginIsProductionWebOrigin);
  for (const raw of [...fromEnv, ...DEFAULT_PRODUCTION_WEB_ORIGINS]) {
    const origin = raw.replace(/\/$/, "");
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

export function isKnownProductionWebHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return knownProductionWebOrigins().some((origin) => {
    try {
      return new URL(origin).hostname.toLowerCase() === h;
    } catch {
      return false;
    }
  });
}

/**
 * Base URL for links embedded in OUTBOUND EMAILS (and other shareable, on-platform
 * links). Recipients authenticate on the canonical domain, so an email must NEVER
 * point at a *.vercel.app deploy/preview URL. Prefers NEXT_PUBLIC_CANONICAL_APP_URL,
 * then NEXT_PUBLIC_APP_URL when it is a non-vercel host (a real custom domain, or
 * localhost for local-dev email testing), otherwise the production domain. It can
 * never return a vercel host.
 */
export function resolveEmailLinkBaseUrl(): string {
  for (const raw of [process.env.NEXT_PUBLIC_CANONICAL_APP_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    const trimmed = trimOrigin(raw);
    if (!trimmed) continue;
    try {
      if (isUsableEmailLinkHost(new URL(trimmed).hostname)) return trimmed;
    } catch {
      /* ignore malformed env value */
    }
  }
  return PRODUCTION_APP_ORIGIN;
}

/**
 * Origin for shareable links (invites). Prefers a canonical custom domain
 * over the default *.vercel.app deployment URL.
 */
export function resolveShareableAppOrigin(browserOrigin?: string): string {
  const canonical = trimOrigin(process.env.NEXT_PUBLIC_CANONICAL_APP_URL);
  if (canonical) return canonical;

  const browser = trimOrigin(browserOrigin);
  if (browser) {
    try {
      const host = new URL(browser).hostname;
      // Multi-agent sandboxes (cursor-1 @3010, cursor-2 @3011, …) must keep the
      // port the browser is on. Folding localhost to NEXT_PUBLIC_APP_URL bounced
      // signup and OAuth return URLs to :3000 or another agent's port.
      if (isLocalHost(host)) return browser;
      if (!isVercelDeploymentHost(host)) return browser;
    } catch {
      /* ignore malformed browser origin */
    }
  }

  const env = trimOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (env) {
    try {
      const host = new URL(env).hostname;
      if (!isVercelDeploymentHost(host)) return env;
    } catch {
      return env;
    }
  }

  return browser || env || "http://localhost:3000";
}

/**
 * Origin the browser actually requested, derived from the Host header.
 *
 * The dev server binds 0.0.0.0 (`next dev --hostname 0.0.0.0`) and `request.url`
 * reflects that bind address, not the Host header — so absolute URLs built from
 * `request.url` bounce a localhost user to 0.0.0.0, a different cookie host where
 * their session doesn't exist. Trust `x-forwarded-*` first (Vercel), then Host,
 * falling back to the request URL's own origin.
 */
export function resolveRequestOrigin(req: Request): string {
  const url = new URL(req.url);
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host")?.trim();
  if (!host) return url.origin;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/**
 * Resolve the app origin for Stripe return URLs.
 *
 * When the request comes from localhost, always use that origin so local checkout
 * does not redirect to production (NEXT_PUBLIC_APP_URL) after payment.
 *
 * Otherwise prefer an explicit public app URL when it points to a non-local host,
 * falling back to the request origin for production deployments.
 */
export function resolveAppOrigin(req: Request): string {
  const requestOrigin = resolveRequestOrigin(req).replace(/\/$/, "");
  try {
    const requestHost = new URL(requestOrigin).hostname.toLowerCase();
    if (isLocalHost(requestHost)) {
      return requestOrigin;
    }
  } catch {
    /* ignore malformed request URL */
  }

  const shareable = resolveShareableAppOrigin(requestOrigin);
  if (shareable !== "http://localhost:3000") {
    try {
      const host = new URL(shareable).hostname;
      if (!isLocalHost(host)) return shareable;
    } catch {
      /* fall through */
    }
  }

  const envUrl = trimOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (!isLocalHost(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      /* ignore malformed env and fall back to request */
    }
  }

  return requestOrigin;
}
