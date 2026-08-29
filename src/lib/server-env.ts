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
 * `PROPLANE_PAYMENT_WAIVER_CODE` when a different comp code is needed.
 */
export const BUILTIN_PAYMENT_WAIVER_CODE = "FREE100";

/** Server-only env var for the active payment-waiver code (`PROPLANE_PAYMENT_WAIVER_CODE`). */
export const PAYMENT_WAIVER_CODE_ENV = "PROPLANE_PAYMENT_WAIVER_CODE";

/** @deprecated Use `PROPLANE_PAYMENT_WAIVER_CODE`. Read only when the new name is unset. */
const LEGACY_PAYMENT_WAIVER_CODE_ENV = "AXIS_PAYMENT_WAIVER_CODE";

function readPaymentWaiverCodeFromEnv(): string {
  const primary = process.env[PAYMENT_WAIVER_CODE_ENV]?.trim();
  if (primary) return primary;
  return process.env[LEGACY_PAYMENT_WAIVER_CODE_ENV]?.trim() ?? "";
}

/**
 * Payment-waiver code that bypasses Stripe checkout, or null when no waiver is available.
 *
 * The built-in code is a CONVENIENCE FOR DEVELOPMENT and must never be live in production: it is
 * a fixed string sitting in a public repo, and `paymentWaiverCodeMatches` compares
 * case-insensitively and ignores punctuation, so anyone typing "free100" would be handed
 * paid-tier access with no Stripe checkout. Production therefore requires
 * `PROPLANE_PAYMENT_WAIVER_CODE` to be set explicitly, and grants no waiver at all without it.
 *
 * Same shape as `getAdminRegisterKey` directly above, and for the same reason: a comp code is a
 * credential, and a credential that ships in the source is not one.
 */
export function getPaymentWaiverCode(): string | null {
  const fromEnv = readPaymentWaiverCodeFromEnv();
  if (fromEnv) return fromEnv;
  return isProductionRuntime() ? null : BUILTIN_PAYMENT_WAIVER_CODE;
}

/** Normalize user input (`free100`, `FREE 100`) for comparison. */
export function normalizePaymentWaiverCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function paymentWaiverCodeMatches(promo: string): boolean {
  const normalized = normalizePaymentWaiverCode(promo);
  if (!normalized) return false;
  // No configured waiver means NO code matches — never fall back to the built-in here, or
  // production would accept it through this path regardless of what the getter decided.
  const active = getPaymentWaiverCode();
  if (!active) return false;
  return normalized === normalizePaymentWaiverCode(active);
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
