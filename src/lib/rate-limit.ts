import "server-only";
import { createHmac } from "node:crypto";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Bucket = { count: number; resetAt: number };
export type RateLimitResult = { ok: boolean; unavailable?: true };

const buckets = new Map<string, Bucket>();

/**
 * Atomic shared limit on every deployed/production runtime. Only local dev and
 * tests use memory. A database/configuration failure denies the request; it must
 * never fall back to a per-instance bucket on a deployed server.
 * Apply the rate_limit_buckets migration BEFORE deploying this change.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (!key || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000) {
    throw new Error("Invalid rate limit configuration.");
  }
  if (process.env.NODE_ENV !== "test" &&
      (process.env.NODE_ENV === "production" || process.env.VERCEL === "1" ||
       process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview")) {
    try {
      const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!secret) throw new Error("Rate limit credentials unavailable.");
      // Do not store raw IPs/emails/phone numbers in the limiter's table. Include
      // policy parameters so two independently configured policies never collide.
      const bucketKey = createHmac("sha256", secret)
        .update(JSON.stringify(["rate-limit-v1", key, limit, windowMs])).digest("hex");
      const { data, error } = await createSupabaseServiceRoleClient()
        .rpc("consume_rate_limit", { p_bucket_key: bucketKey, p_limit: limit, p_window_ms: windowMs })
        .abortSignal(AbortSignal.timeout(3000));
      if (error || typeof data !== "boolean") throw new Error("Rate limit store unavailable.");
      return { ok: data };
    } catch {
      // No raw bucket, request identity, provider error, or credential in logs.
      console.error("[security] shared_rate_limit_unavailable");
      return { ok: false, unavailable: true };
    }
  }
  const now = Date.now();
  if (buckets.size >= 10_000) {
    for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
    if (buckets.size >= 10_000 && !buckets.has(key)) return { ok: false };
  }
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
