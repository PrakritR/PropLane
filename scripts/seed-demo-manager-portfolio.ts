#!/usr/bin/env npx tsx
/**
 * Writes the "Seattle Homes" portfolio (`buildDemoIdleSnapshot()`,
 * `src/lib/demo/demo-guided-data.ts` — captain 2026-09-25) onto the
 * CANONICAL demo manager account (`manager@test.proplane.local`) so the
 * `/demo` mirror (`DEMO_PORTAL_MIRROR_ENABLED`, now back on — see
 * `src/lib/demo/demo-mirror-flag.ts`) has real rows to read instead of the
 * static fallback alone. Idempotent — every write is an upsert keyed by id
 * (`src/lib/demo/canonical-demo-portfolio-db.ts`), so re-running this is
 * always safe and never deletes anything.
 *
 *   npx tsx scripts/seed-demo-manager-portfolio.ts
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the
 * environment, falling back to .env (same pattern as
 * scripts/seed-dev-manager-portfolio.ts). Refuses to run anywhere except the
 * dedicated test/dev Supabase project (ref emstjswhotsnyksqhqyf) — this is an
 * ALLOW-list, stricter than a production deny-list, because this script's
 * whole job is writing real rows onto a specific shared account.
 *
 * ============================================================================
 * PRODUCTION IS NOT SEEDED BY THIS SCRIPT, ON PURPOSE.
 * ============================================================================
 * This has only ever been run against the dev/test project. Production's
 * canonical `manager@test.proplane.local` account has NOT been re-seeded with
 * Seattle Homes — per `demo-mirror-flag.ts`, once this code ships, production
 * `/demo` will surface whatever is ACTUALLY sitting on that account today
 * (which, per the account's history, may still be the old deleted fictional
 * fixture — Ava Nguyen, The Pioneer, Cascade Lofts, …). Re-seeding production
 * is a separate, deliberate action for the captain to authorize and run —
 * this script's own guard below refuses to target it even if asked to.
 *
 * The manager/resident/vendor auth accounts must already exist (created by
 * `npm run test:seed` / `npm run seed:dev` / `POST /api/admin/provision-
 * sandbox-accounts`) — this script only writes the portfolio, not the logins.
 */
import fs from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isProductionSupabaseProjectUrl } from "../tests/helpers/canonical-production-accounts.mjs";
import {
  CANONICAL_DEMO_MANAGER_EMAIL,
  CANONICAL_DEMO_RESIDENT_EMAIL,
  CANONICAL_DEMO_VENDOR_EMAIL,
} from "@/lib/demo/demo-canonical-accounts";
import { buildDemoIdleSnapshot } from "@/lib/demo/demo-guided-data";
import { remapDemoSnapshotForDb } from "@/lib/demo/demo-portfolio-db-remap";
import { seedCanonicalDemoPortfolio } from "@/lib/demo/canonical-demo-portfolio-db";

// ---- env (process env first, .env fallback) --------------------------------

function loadDotEnvFallback() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 1 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
  }
}
loadDotEnvFallback();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (env or .env).");
  process.exit(1);
}

// Hard production guard, fail-closed, AND an allow-list of the one project
// this script may ever target — belt and suspenders, since this script's job
// is specifically to write onto a shared canonical account.
const TEST_SUPABASE_PROJECT_REF = "emstjswhotsnyksqhqyf";
const allowedRef = process.env.SEED_SUPABASE_PROJECT_REF?.trim() || TEST_SUPABASE_PROJECT_REF;
const misspelledRef = process.env.AXIS_PROD_SUPABSE_REF?.trim();
let actualRef = "";
try {
  actualRef = new URL(url).hostname.split(".")[0] ?? "";
} catch {
  actualRef = "";
}
if (
  isProductionSupabaseProjectUrl(url) ||
  (misspelledRef && new URL(url).hostname === `${misspelledRef}.supabase.co`)
) {
  console.error("Refusing to seed the production Supabase project.");
  process.exit(1);
}
if (actualRef !== allowedRef) {
  console.error(
    `Refusing to seed ${url}: not the dedicated test/dev Supabase project (${allowedRef}). ` +
      "This script only ever writes to that one project.",
  );
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserIdByEmail(client: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function main() {
  const [managerUserId, residentUserId, vendorUserId] = await Promise.all([
    findUserIdByEmail(db, CANONICAL_DEMO_MANAGER_EMAIL),
    findUserIdByEmail(db, CANONICAL_DEMO_RESIDENT_EMAIL),
    findUserIdByEmail(db, CANONICAL_DEMO_VENDOR_EMAIL),
  ]);
  if (!managerUserId || !residentUserId || !vendorUserId) {
    console.error(
      "Canonical demo accounts are not provisioned yet. Run `npm run seed:dev` (or `npm run test:seed`) " +
        "first, then re-run this script.",
    );
    process.exit(1);
  }

  const ctx = {
    managerUserId,
    residentUserId,
    vendorUserId,
    residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
    vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
    residentAxisId: "AXIS-TESTRSID",
    managerEmail: CANONICAL_DEMO_MANAGER_EMAIL,
  };

  // The idle snapshot's rows carry synthetic demo-* scope ids
  // (DEMO_MANAGER_USER_ID / DEMO_RESIDENT_USER_ID) — remap them onto the
  // real account ids resolved above before writing.
  const snapshot = remapDemoSnapshotForDb(buildDemoIdleSnapshot(), ctx);

  // skipGlobalScheduleSingletons: the portfolio's one tour must never
  // overwrite axis_admin_planned_events_v1 / axis_admin_partner_inquiries_v1,
  // which hold every OTHER account's real seeded tour data too.
  await seedCanonicalDemoPortfolio(db, ctx, { snapshot, skipGlobalScheduleSingletons: true });

  console.log(
    `Seeded Seattle Homes (${snapshot.properties.length} properties, ${snapshot.leases.length} leases, ` +
      `${snapshot.charges.length} charges, ${snapshot.applications.length} applications, ` +
      `${snapshot.schedule.plannedEvents.length} tours) onto ${CANONICAL_DEMO_MANAGER_EMAIL}.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
