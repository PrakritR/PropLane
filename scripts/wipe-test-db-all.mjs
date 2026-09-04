#!/usr/bin/env node
/**
 * Nuclear wipe of the dev/test Supabase project — all portal rows + all auth users.
 * NEVER runs against production.
 *
 * Usage:
 *   ALLOW_DEV_WIPE=1 npm run wipe:test:all
 *   ALLOW_DEV_WIPE=1 node --env-file=.env.test scripts/wipe-test-db-all.mjs
 *
 * Does NOT re-seed. Run `npm run test:seed` only when E2E fixtures are needed.
 */
import { createClient } from "@supabase/supabase-js";
import { assertTestProjectUrl, TEST_SUPABASE_PROJECT_REF } from "../tests/helpers/canonical-test-accounts.mjs";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "../tests/helpers/canonical-production-accounts.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.ALLOW_DEV_WIPE?.trim() !== "1") {
  console.error("Wipe blocked: set ALLOW_DEV_WIPE=1 to confirm you intend to delete ALL test data.");
  process.exit(1);
}
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
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
assertTestProjectUrl(url);

const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Delete every row (service role). Uses id-neq sentinel so PostgREST accepts the filter. */
async function deleteAllFrom(table) {
  const { data, error } = await sb
    .from(table)
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000")
    .select("id");
  if (error) {
    const msg = String(error.message ?? "");
    if (msg.includes("does not exist") || msg.includes("Could not find")) {
      console.log(`  skip ${table} (table missing)`);
      return 0;
    }
    throw new Error(`${table}: ${error.message}`);
  }
  const n = data?.length ?? 0;
  if (n > 0) console.log(`  deleted ${n} from ${table}`);
  return n;
}

/** Child / dependent portal tables first, then profiles, then auth.users. */
const PORTAL_TABLES = [
  "agent_messages",
  "work_order_bids",
  "work_order_vendor_offers",
  "vendor_payouts",
  "vendor_invites",
  "vendor_availability_rules",
  "portal_work_order_records",
  "portal_service_request_records",
  "portal_household_charge_records",
  "portal_recurring_rent_profile_records",
  "portal_lease_pipeline_records",
  "portal_resident_lease_upload_records",
  "manager_application_records",
  "portal_inbox_thread_records",
  "portal_scheduled_inbox_message_records",
  "portal_schedule_records",
  "manager_promotion_records",
  "manager_vendor_records",
  "manager_property_records",
  "manager_expense_entries",
  "manager_expense_records",
  "ledger_entries",
  "chart_of_accounts",
  "screening_orders",
  "cosigner_submission_records",
  "manager_automation_settings",
  "scheduled_message_overrides",
  "vendor_tax_profiles",
  "manager_tax_profiles",
  "portal_pro_relationship_records",
  "portal_outbound_mail_records",
  "portal_bug_feedback_records",
  "account_link_invites",
  "agent_sessions",
  "device_push_tokens",
  "manager_purchases",
  "audit_log",
];

async function listAllUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    users.push(...(data.users ?? []));
    if ((data.users ?? []).length < 1000) break;
    page += 1;
  }
  return users;
}

async function main() {
  console.log(`\n=== Full test DB wipe (project ${ref || TEST_SUPABASE_PROJECT_REF}) ===\n`);

  let portalRows = 0;
  for (const table of PORTAL_TABLES) {
    portalRows += await deleteAllFrom(table);
  }

  await deleteAllFrom("profile_roles");
  portalRows += await deleteAllFrom("profiles");

  const users = await listAllUsers();
  let deletedUsers = 0;
  for (const user of users) {
    const email = user.email ?? user.id;
    const { error } = await sb.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`deleteUser(${email}): ${error.message}`);
    console.log(`  deleted auth user ${email}`);
    deletedUsers += 1;
  }

  console.log(`\nDone. Deleted ${portalRows} portal/profile rows and ${deletedUsers} auth users.`);
  console.log("E2E fixtures: run `npm run test:seed` only when running Playwright tests.");
  console.log("\nBrowser caches are NOT cleared by this script.");
  console.log("On each sandbox port, run once after wipe:");
  console.log("  npm run sandbox:pin -- <port>   # e.g. 3010 for cursor-1");
  console.log("  open http://localhost:<port>/auth/sign-in?clear_cache=1");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
