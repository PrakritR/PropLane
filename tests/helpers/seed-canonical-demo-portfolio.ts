#!/usr/bin/env npx tsx
/**
 * CLI wrapper: writes the idle `/demo` portfolio into the canonical test
 * Supabase accounts. Invoked from tests/helpers/seed-test-db.mjs after
 * manager / resident / vendor auth users exist. The implementation lives in
 * src/lib/demo/canonical-demo-portfolio-db.ts (shared with the admin
 * provision-sandbox-accounts route — keep ONE implementation).
 *
 * Env (required):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   SEED_MANAGER_USER_ID, SEED_RESIDENT_USER_ID, SEED_VENDOR_USER_ID
 *   SEED_RESIDENT_AXIS_ID (default AXIS-TESTRSID)
 */
import { createClient } from "@supabase/supabase-js";
import {
  CANONICAL_DEMO_RESIDENT_EMAIL,
  CANONICAL_DEMO_VENDOR_EMAIL,
} from "@/lib/demo/demo-canonical-accounts";
import { seedCanonicalDemoPortfolio } from "@/lib/demo/canonical-demo-portfolio-db";
import { assertCanonicalDemoPortfolioContext } from "@/lib/demo/demo-portfolio-db-remap";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const managerUserId = process.env.SEED_MANAGER_USER_ID?.trim();
const residentUserId = process.env.SEED_RESIDENT_USER_ID?.trim();
const vendorUserId = process.env.SEED_VENDOR_USER_ID?.trim();
const residentAxisId = process.env.SEED_RESIDENT_AXIS_ID?.trim() || "AXIS-TESTRSID";

if (!url || !serviceKey || !managerUserId || !residentUserId || !vendorUserId) {
  console.error(
    "Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_MANAGER_USER_ID, SEED_RESIDENT_USER_ID, SEED_VENDOR_USER_ID",
  );
  process.exit(1);
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ctx = {
  managerUserId,
  residentUserId,
  vendorUserId,
  residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
  vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
  residentAxisId,
  managerEmail: process.env.SEED_MANAGER_EMAIL?.toLowerCase() ?? "manager@test.proplane.local",
};

assertCanonicalDemoPortfolioContext(ctx);

async function main() {
  // buildDemoIdleSnapshot() carries the Seattle Homes portfolio (captain
  // 2026-09-25) — this pipeline runs on every `npm run test:seed` / `seed:dev`
  // across the whole team's shared dev/test project, so it must never touch
  // the two DEPLOYMENT-WIDE schedule singletons (which hold every OTHER
  // account's real seeded tour data, not just this one's).
  await seedCanonicalDemoPortfolio(db, ctx, { skipGlobalScheduleSingletons: true });
  console.log("Seeded canonical demo portfolio for manager / resident / vendor test accounts.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
