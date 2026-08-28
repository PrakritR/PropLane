import "server-only";

/**
 * True when running in the production deployment. Prefers Vercel's VERCEL_ENV
 * ("production" | "preview" | "development") and falls back to NODE_ENV when
 * VERCEL_ENV is unset (e.g. self-hosted or local builds).
 */
export function isProductionRuntime(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
}

/**
 * Expected admin registration key. In production this must be set via the
 * server-only AXIS_ADMIN_REGISTER_KEY env var; if unset, admin registration is
 * disabled (fail closed). In dev it falls back to a well-known default for
 * convenience.
 */
export function getAdminRegisterKey(): string | null {
  const fromEnv = process.env.AXIS_ADMIN_REGISTER_KEY?.trim();
  if (fromEnv) return fromEnv;
  return isProductionRuntime() ? null : "prakrit-admin-register";
}

/**
 * Built-in payment-waiver promo. Grants lifetime paid-tier access (no Stripe
 * subscription) when validated server-side. Override only via
 * `AXIS_PAYMENT_WAIVER_CODE` when a different comp code is needed.
 */
export const BUILTIN_PAYMENT_WAIVER_CODE = "FREE100";

/**
 * Payment-waiver code that bypasses Stripe checkout. Defaults to FREE100 in every
 * environment; set `AXIS_PAYMENT_WAIVER_CODE` to substitute a different code.
 */
export function getPaymentWaiverCode(): string {
  const fromEnv = process.env.AXIS_PAYMENT_WAIVER_CODE?.trim();
  return fromEnv || BUILTIN_PAYMENT_WAIVER_CODE;
}

/** Normalize user input (`free100`, `FREE 100`) for comparison. */
export function normalizePaymentWaiverCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function paymentWaiverCodeMatches(promo: string): boolean {
  const normalized = normalizePaymentWaiverCode(promo);
  if (!normalized) return false;
  return normalized === normalizePaymentWaiverCode(getPaymentWaiverCode());
}

/**
 * Fail-closed guard against a non-production runtime (local dev, tests, preview)
 * accidentally pointing at the production Supabase project. Without this, a
 * stale local `.env` silently reads and writes the live database.
 *
 * The production project ref is supplied out-of-band via the optional
 * AXIS_PROD_SUPABASE_REF env var (set it in the Vercel Production scope and in
 * local `.env` files). When unset, the guard is a no-op so the check never
 * blocks environments that have not opted in.
 *
 * Throws when a non-production runtime targets the production project.
 */
export function assertNonProdDatabase(): void {
  if (isProductionRuntime()) return;

  const prodRef = process.env.AXIS_PROD_SUPABASE_REF?.trim();
  if (!prodRef) return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  // Host-based match (`<ref>.supabase.co`) rather than a bare substring, so an
  // unrelated value that merely contains the ref cannot trip the guard.
  if (url.includes(`${prodRef}.supabase.co`)) {
    throw new Error(
      `Refusing to start: NEXT_PUBLIC_SUPABASE_URL points at the production ` +
        `Supabase project (${prodRef}) from a non-production runtime. Local ` +
        `dev and tests must use the dev/test project. See ` +
        `docs/database-environments.md.`,
    );
  }
}
