#!/usr/bin/env node
/**
 * Wipe seeded portal rows for a manager on dev/test or demo Supabase — NEVER production.
 * Never automatic: do not run unless a human explicitly asked.
 *
 * Deletes rows owned by the target manager across portal tables, then optional
 * re-seed via seed-demo-manager-workflow.mjs or seed-demo-supabase.mjs.
 *
 * Usage (dev/test project):
 *   ALLOW_DEV_WIPE=1 node --env-file=.env.test scripts/wipe-dev-supabase.mjs
 *   ALLOW_DEV_WIPE=1 SEED_MANAGER_EMAIL=manager@test.proplane.local node --env-file=.env.test scripts/wipe-dev-supabase.mjs
 *
 * Usage (dedicated demo project):
 *   ALLOW_DEV_WIPE=1 DEMO_SUPABASE_PROJECT_REF=<demo project ref> \
 *     node --env-file=.env.local scripts/wipe-dev-supabase.mjs --demo
 *   (uses DEMO_SUPABASE_URL / DEMO_SUPABASE_SERVICE_ROLE_KEY; DEMO_SUPABASE_PROJECT_REF
 *   must exactly match that URL's project ref — an allowlist, not just "not production")
 *
 * Re-seed after wipe:
 *   node --env-file=.env.test scripts/seed-demo-manager-workflow.mjs
 *   ALLOW_DEMO_SEED=1 AXIS_DEMO_SEED_PASSWORD='…' node --env-file=.env.local scripts/seed-demo-supabase.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { assertTestProjectUrl, TEST_SUPABASE_PROJECT_REF } from "../tests/helpers/canonical-test-accounts.mjs";
import {
  assertAllowlistedDemoProjectUrl,
  PROD_DEMO_MANAGER_EMAIL,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "../tests/helpers/canonical-production-accounts.mjs";

const useDemoProject = process.argv.includes("--demo");
const url = useDemoProject
  ? process.env.DEMO_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_DEMO_SUPABASE_URL?.trim()
  : process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = useDemoProject
  ? process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY?.trim()
  : process.env.SUPABASE_SERVICE_ROLE_KEY;
const targetEmail = (
  process.env.SEED_MANAGER_EMAIL ||
  (useDemoProject ? PROD_DEMO_MANAGER_EMAIL : "manager@test.proplane.local")
).trim().toLowerCase();

if (process.env.ALLOW_DEV_WIPE?.trim() !== "1") {
  console.error("Wipe blocked: set ALLOW_DEV_WIPE=1 to confirm you intend to delete seeded data.");
  process.exit(1);
}
if (!url || !serviceKey) {
  console.error("Missing Supabase URL or service role key.");
  process.exit(1);
}

let ref = "";
try {
  ref = new URL(url).hostname.split(".")[0] ?? "";
} catch {
  ref = "";
}
if (ref === PRODUCTION_SUPABASE_PROJECT_REF) {
  console.error(`Refusing wipe on production project (${PRODUCTION_SUPABASE_PROJECT_REF}).`);
  process.exit(1);
}
if (useDemoProject) {
  assertAllowlistedDemoProjectUrl(url);
} else {
  assertTestProjectUrl(url);
}

const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function must(promise, label) {
  const { error, data } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

const MANAGER_SCOPED_TABLES = [
  "manager_property_records",
  "manager_application_records",
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
  "portal_lease_pipeline_records",
  "portal_work_order_records",
  "work_order_bids",
  "manager_vendor_records",
  "portal_service_request_records",
  "portal_schedule_records",
  "portal_inbox_thread_records",
  "portal_promotion_records",
  "manager_expense_records",
  "vendor_payouts",
  "vendor_invites",
];

async function resolveManagerUserId() {
  const { data: list, error } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  const user = list.users.find((u) => u.email?.toLowerCase() === targetEmail);
  if (!user) {
    console.log(`No auth user for ${targetEmail} — nothing to wipe.`);
    return null;
  }
  return user.id;
}

async function wipeManagerScope(managerUserId) {
  let total = 0;
  for (const table of MANAGER_SCOPED_TABLES) {
    const { data, error } = await sb.from(table).delete().eq("manager_user_id", managerUserId).select("id");
    if (error) {
      const msg = String(error.message ?? "");
      if (msg.includes("does not exist") || msg.includes("Could not find")) {
        console.log(`  skip ${table} (table missing)`);
        continue;
      }
      throw new Error(`${table}: ${error.message}`);
    }
    const n = data?.length ?? 0;
    if (n > 0) console.log(`  deleted ${n} from ${table}`);
    total += n;
  }
  return total;
}

async function main() {
  console.log(`\n=== Wipe seeded data (${useDemoProject ? "demo" : "dev/test"} project ${ref || TEST_SUPABASE_PROJECT_REF}) ===`);
  console.log(`Target manager: ${targetEmail}\n`);

  const managerUserId = await resolveManagerUserId();
  if (!managerUserId) {
    console.log("Done (no manager account).");
    return;
  }

  const deleted = await wipeManagerScope(managerUserId);
  console.log(`\nDeleted ${deleted} rows for manager ${managerUserId}.`);
  console.log("\nRe-seed:");
  if (useDemoProject) {
    console.log("  ALLOW_DEMO_SEED=1 AXIS_DEMO_SEED_PASSWORD='…' node --env-file=.env.local scripts/seed-demo-supabase.mjs");
  } else {
    console.log("  node --env-file=.env.test scripts/seed-demo-manager-workflow.mjs");
  }
  printDevResetEpochInstruction();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// A dev wipe leaves the browser's `axis:*` mirror behind, so the portal keeps
// showing properties that no longer exist — which reads as "deletion didn't
// work", not as a stale cache, and silently invalidates any QA run made after
// it (PRP-195). Print the epoch to set so the client clears itself on boot.
function printDevResetEpochInstruction() {
  const epoch = new Date().toISOString();
  console.log(
    `\n  ⚠  The browser still holds a local mirror of the data just removed.\n` +
      `     Set this in .env.local and restart the dev server so every tab clears\n` +
      `     its cache on next load:\n\n` +
      `       NEXT_PUBLIC_DEV_RESET_EPOCH=${epoch}\n\n` +
      `     Or clear site data for the dev origin by hand.\n`,
  );
}

