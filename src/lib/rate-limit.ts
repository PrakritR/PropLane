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
 *
 * `cost` is how many tokens ONE request spends — a send to several new addresses
 * spends one per address. It is all-or-nothing: a request that cannot have the
 * whole cost is refused having spent nothing, so a refusal never eats the budget
 * of the work it did not do. Asking for the tokens one call at a time cannot give
 * that, because the calls already granted cannot be handed back. A cost above 1 runs
 * on `consume_rate_limit_cost` (migration `20261111120000_rate_limit_cost`), which must
 * be applied before deploying a multi-token caller; one token stays on the original
 * three-argument function, so nothing already deployed depends on the new migration.
 */
export async function rateLimit(key: string, limit: number, windowMs: number, cost = 1): Promise<RateLimitResult> {
  if (!key || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000 ||
      !Number.isSafeInteger(cost) || cost < 1) {
    throw new Error("Invalid rate limit configuration.");
  }
  // More than the whole window's budget can never be served, and must never be stored.
  if (cost > limit) return { ok: false };
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
      // The one-token call stays on the three-argument function every deployed caller
      // already uses; only a multi-token request needs the cost-aware one.
      const { data, error } = await createSupabaseServiceRoleClient()
        .rpc(
          cost === 1 ? "consume_rate_limit" : "consume_rate_limit_cost",
          cost === 1
            ? { p_bucket_key: bucketKey, p_limit: limit, p_window_ms: windowMs }
            : { p_bucket_key: bucketKey, p_limit: limit, p_window_ms: windowMs, p_cost: cost },
        )
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
    buckets.set(key, { count: cost, resetAt: now + windowMs });
    return { ok: true };
  }

  if (existing.count + cost > limit) {
    return { ok: false };
  }

  existing.count += cost;
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
