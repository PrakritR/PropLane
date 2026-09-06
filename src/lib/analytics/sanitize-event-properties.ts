/** Bearer links must never reach analytics, including nested auth redirects. */
function containsBearerUrl(value: string): boolean {
  let decoded = value;
  for (let pass = 0; pass < 5; pass += 1) {
    if (/[?&#](?:token|access_token|refresh_token|invite_token|code)=/i.test(decoded)) return true;
    // The existing multi-use invite surface carries its secret in the path.
    if (/\/invite\/[^/?#\s]+/.test(decoded)) return true;
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
    return (path.includes("%")
      ? "[redacted sensitive URL]"
      : path.replace(/\/invite\/[^/\s]+/, "/invite/[redacted]") + "?[redacted]") as T;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeAnalyticsProperties(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeAnalyticsProperties(item)]),
    ) as T;
  }
  return value;
}
