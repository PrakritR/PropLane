/**
 * Normalizes a `?next=` destination to a SAME-ORIGIN path, or null.
 *
 * The usual guard in the auth screens is `value.startsWith("/")`, which accepts
 * `//evil.example.com` — a protocol-relative URL the browser resolves to another
 * origin, turning any auth redirect into an open redirect. Requiring a single
 * leading slash (and rejecting backslashes, which some browsers normalize to
 * `/`) keeps the value inside the app.
 *
 * Returns null for anything it cannot vouch for, so callers fall back to their
 * own default rather than following attacker-chosen input.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (!raw.startsWith("/")) return null;
  // `//host` and `/\host` both leave the origin.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("\\")) return null;
  // A scheme cannot appear in a path-only destination.
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return raw;
}
