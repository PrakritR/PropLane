import "server-only";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * Lightweight in-memory fixed-window rate limiter. Per-instance only (resets on
 * deploy / cold start), no external dependencies. Suitable for blunting
 * enumeration and abuse on individual routes; not a substitute for a durable
 * distributed limiter under heavy multi-instance load.
 */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean } {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (existing.count >= limit) {
    return { ok: false };
  }

  existing.count += 1;
  return { ok: true };
}

/**
 * Best-effort client IP from forwarding headers; falls back to "unknown".
 *
 * Reads the LAST `x-forwarded-for` entry, not the first. A proxy APPENDS the
 * address it observed, so the rightmost hop is the one our own infrastructure
 * saw and the leftmost is whatever the caller chose to send. Keying the limiter
 * on the leftmost value made every IP bucket in the product caller-controlled:
 * rotating one header defeated password-reset throttling, the enumeration caps,
 * and the limits on the unauthenticated Anthropic-backed routes at once.
 *
 * `x-vercel-forwarded-for` is preferred where present because Vercel sets it
 * itself and it is not caller-appendable.
 */
export function clientIpFrom(req: Request): string {
  const vercel = req.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
