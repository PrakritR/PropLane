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
export const browserSecurityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "base-uri 'self'; frame-ancestors 'self'; object-src 'self' blob: https://*.supabase.co https://*.supabase.in",
  },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera and location remain available to the top-level app/native uploads.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
];
