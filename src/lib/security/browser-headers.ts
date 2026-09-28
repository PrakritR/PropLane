/**
 * Enforced, static-rendering-compatible browser protections. Same-origin
 * framing and PDF objects are used by lease/document previews and must work in
 * both the website and the Capacitor WebView. Route-specific CSPs (notably the
 * sandboxed inbox attachment response) can and should be stricter.
 *
 * This is a baseline CSP, NOT a strict script/XSS policy: it deliberately does
 * not claim script-src coverage. Nonces need request-time rendering and cannot
 * be added to cached HTML in a response header alone. See docs/security/README.md.
 */
const PROD_FRAME_ANCESTORS = "'self'";

/**
 * The PropLane mock-kit studio (docs/agents/studio-live.md) frames the real
 * app to preview real screens signed in as a real dev account. Only ever
 * appended to frame-ancestors in local development — production and preview
 * builds (`NODE_ENV !== "development"`) never see these extra origins.
 */
const STUDIO_DEV_FRAME_ANCESTORS = [
  "http://localhost:8960",
  "http://127.0.0.1:8960",
  "http://127.0.0.1:4387",
];

function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV === "development";
}

function contentSecurityPolicyValue(): string {
  const frameAncestors = isDevelopmentRuntime()
    ? [PROD_FRAME_ANCESTORS, ...STUDIO_DEV_FRAME_ANCESTORS].join(" ")
    : PROD_FRAME_ANCESTORS;
  return `base-uri 'self'; frame-ancestors ${frameAncestors}; object-src 'self' blob: https://*.supabase.co https://*.supabase.in`;
}

/** Exported for tests: rebuilds the header set from the CURRENT process.env.NODE_ENV. */
export function buildBrowserSecurityHeaders(): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicyValue() },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Camera and location remain available to the top-level app/native uploads.
    { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
  ];
  // X-Frame-Options has no multi-origin form (ALLOW-FROM is deprecated and
  // single-origin only), and a browser that honors frame-ancestors already
  // ignores it per spec. Dropping it in development is what lets the studio's
  // extra frame-ancestors origins actually take effect instead of being
  // shadowed by a stricter legacy header in browsers that still read it.
  // Production and preview keep it exactly as before.
  if (!isDevelopmentRuntime()) {
    headers.splice(1, 0, { key: "X-Frame-Options", value: "SAMEORIGIN" });
  }
  return headers;
}

export const browserSecurityHeaders = buildBrowserSecurityHeaders();
