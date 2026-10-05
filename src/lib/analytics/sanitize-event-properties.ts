/**
 * A linked-form share link: `/f/<token>`. The token is the whole credential and it sits in the path, so no query
 * scrub removes it. `/f/open/<request id>` is the session-scoped page (no secret) and stays readable. Matched on
 * the decoded value too, so a `next=%2Ff%2F<token>` redirect is caught.
 */
const LINKED_FORM_TOKEN_PATH = /\/f\/(?!open(?:[/?#&\s]|$))[A-Za-z0-9_-]{16,}/;
const LINKED_FORM_TOKEN_PATH_GLOBAL = /\/f\/(?!open(?:[/?#&\s]|$))[A-Za-z0-9_-]{16,}/g;

/** Bearer links must never reach analytics, including nested auth redirects. */
function containsBearerUrl(value: string): boolean {
  let decoded = value;
  for (let pass = 0; pass < 5; pass += 1) {
    if (/[?&#](?:token|access_token|refresh_token|invite_token|code)=/i.test(decoded)) return true;
    // The existing multi-use invite surface carries its secret in the path.
    if (/\/invite\/[^/?#\s]+/.test(decoded)) return true;
    if (LINKED_FORM_TOKEN_PATH.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return false;
}

export function sanitizeAnalyticsProperties<T>(value: T): T {
  if (typeof value === "string") {
    if (!containsBearerUrl(value)) return value;
    // Retain the page path for funnels, removing the entire query/fragment so
    // nested `next=` redirects, referrers and history URLs cannot retain tokens.
    const path = value.split(/[?#]/, 1)[0];
    if (path.includes("%")) return "[redacted sensitive URL]" as T;
    const withoutInvite = path.replace(/\/invite\/[^/\s]+/, "/invite/[redacted]");
    const scrubbed = withoutInvite.replace(LINKED_FORM_TOKEN_PATH_GLOBAL, "/f/[redacted]");
    // A bare share path is fully described by `/f/[redacted]`; anything else keeps the marker that a query or
    // fragment was removed.
    const bareShareToken = scrubbed !== withoutInvite && withoutInvite === path && value.length === path.length;
    return (bareShareToken ? scrubbed : `${scrubbed}?[redacted]`) as T;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeAnalyticsProperties(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeAnalyticsProperties(item)]),
    ) as T;
  }
  return value;
}
