import "server-only";

/**
 * GET /api/dev/studio-sign-in — signs the browser into a shared dev test
 * account so the PropLane mock-kit studio (docs/agents/studio-live.md) can
 * frame the REAL app, already authenticated as the right role, instead of
 * dropping the captain on a sign-in screen inside the iframe.
 *
 * Three independent refusals, ALL required, fail closed (404, never a
 * redirect to sign-in — this route must not exist as a discoverable surface
 * outside local development):
 *   1. `NODE_ENV === "development"` — never available in a built (production
 *      or preview) deploy, where `next build` always sets NODE_ENV=production
 *      regardless of Vercel target.
 *   2. Request host is localhost/127.0.0.1 — never answers on a LAN IP or a
 *      tunnel, even in a local dev process.
 *   3. `NEXT_PUBLIC_SUPABASE_URL` is the dedicated dev/test Supabase project
 *      (emstjswhotsnyksqhqyf) — never staging (xwszcafaontidfgznlxd) or
 *      production (qahnczmilgptcedaqype), even if someone points a local dev
 *      server at one of those by mistake.
 *
 * Accounts and passwords are read from the SAME E2E_* env vars and defaults
 * every other QA/E2E surface already uses (tests/helpers/canonical-test-accounts.mjs,
 * tests/fixtures/qa-accounts.mjs, tests/helpers/seed-test-db.mjs) — one
 * account registry, not a second one that can drift out of sync with what
 * `npm run test:seed` actually creates.
 */

export type StudioSignInRole = "manager" | "resident" | "vendor" | "admin";

const STUDIO_SIGN_IN_ROLES: readonly StudioSignInRole[] = ["manager", "resident", "vendor", "admin"];

export function isStudioSignInRole(value: string | null): value is StudioSignInRole {
  return value !== null && (STUDIO_SIGN_IN_ROLES as readonly string[]).includes(value);
}

type StudioAccount = { email: string; password: string };

/**
 * `manager` intentionally resolves to the all-portals `testeverything@`
 * sandbox account (docs/agents/demo-sandbox.md), not the plain `manager@`
 * fixture — it carries the fuller seeded portfolio ("make sure I can test
 * everything") and its extra `profile_roles` rows are what let the SAME
 * login also open the admin/resident/vendor portals if a flow needs to
 * cross-check. Dedicated single-role fixtures back resident/vendor/admin.
 */
function studioAccounts(env: NodeJS.ProcessEnv): Record<StudioSignInRole, StudioAccount> {
  return {
    manager: {
      email: (env.E2E_EVERYTHING_EMAIL?.trim() || "testeverything@test.proplane.local").toLowerCase(),
      password: env.E2E_EVERYTHING_PASSWORD?.trim() || "TestEverything123!",
    },
    resident: {
      email: (env.E2E_RESIDENT_EMAIL?.trim() || "resident@test.proplane.local").toLowerCase(),
      password: env.E2E_RESIDENT_PASSWORD?.trim() || "TestResident123!",
    },
    vendor: {
      email: (env.E2E_VENDOR_EMAIL?.trim() || "vendor@test.proplane.local").toLowerCase(),
      password: env.E2E_VENDOR_PASSWORD?.trim() || "TestVendor123!",
    },
    admin: {
      email: (env.E2E_ADMIN_EMAIL?.trim() || "admin@test.proplane.local").toLowerCase(),
      password: env.E2E_ADMIN_PASSWORD?.trim() || "TestAdmin123!",
    },
  };
}

export function studioAccountFor(role: StudioSignInRole, env: NodeJS.ProcessEnv = process.env): StudioAccount {
  return studioAccounts(env)[role];
}

/** Dedicated dev/test Supabase project — see docs/database-environments.md. Never staging or production. */
export const STUDIO_SIGN_IN_SUPABASE_REF = "emstjswhotsnyksqhqyf";

function isLocalRequestHost(hostHeader: string | null): boolean {
  const host = (hostHeader ?? "").split(":")[0]?.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

function isDevTestSupabaseProject(env: NodeJS.ProcessEnv): boolean {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return false;
  try {
    return new URL(raw).hostname === `${STUDIO_SIGN_IN_SUPABASE_REF}.supabase.co`;
  } catch {
    return false;
  }
}

/**
 * The single gate the route handler must check before doing anything else.
 * Takes the request host and env explicitly (rather than reading `process.env`
 * / `headers()` itself) so it is a plain, fully unit-testable function.
 */
export function studioSignInAllowed(
  hostHeader: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NODE_ENV !== "development") return false;
  if (!isLocalRequestHost(hostHeader)) return false;
  if (!isDevTestSupabaseProject(env)) return false;
  return true;
}
