#!/usr/bin/env node
/**
 * Removes rows created by E2E tests matching a testRunId prefix.
 * Usage: node --env-file=.env.test tests/helpers/cleanup-test-db.mjs <testRunId>
 */
import { createClient } from "@supabase/supabase-js";
import { DOGFOOD_KEEP_EMAILS } from "./canonical-test-accounts.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testRunId = process.argv[2]?.trim();

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!testRunId) {
  console.error("Usage: node --env-file=.env.test tests/helpers/cleanup-test-db.mjs <testRunId>");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const tables = [
  "manager_application_records",
  "manager_property_records",
  "portal_household_charge_records",
  "portal_lease_pipeline_records",
  "portal_inbox_thread_records",
  "portal_schedule_records",
  "portal_work_order_records",
  "portal_outbound_mail_records",
  "manager_purchases",
];

try {
  for (const table of tables) {
    try {
      const { data } = await supabase.from(table).select("id, row_data, manager_id, stripe_checkout_session_id");
      const toDelete = (data ?? []).filter((row) => {
        const rd = row.row_data;
        if (rd && typeof rd === "object" && "testRunId" in rd) {
          return String(rd.testRunId) === testRunId || String(rd.id ?? "").includes(testRunId);
        }
        if (String(row.manager_id ?? "").includes(testRunId)) return true;
        if (String(row.stripe_checkout_session_id ?? "").includes(testRunId)) return true;
        return false;
      });
      if (toDelete.length) {
        await supabase.from(table).delete().in(
          "id",
          toDelete.map((r) => r.id),
        );
        console.log(`Deleted ${toDelete.length} from ${table}`);
      }
    } catch {
      // Table may not have all expected columns; skip gracefully.
    }
  }

  // Remove test auth users (resident@test.proplane.local pattern or testRunId in email)
  try {
    const { data: users } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const keep = new Set(DOGFOOD_KEEP_EMAILS.map((email) => email.toLowerCase()));
    const testUsers = (users?.users ?? []).filter((u) => {
      const email = (u.email ?? "").toLowerCase();
      if (!email || keep.has(email)) return false;
      return email.includes("@test.proplane.local") || email.includes(testRunId);
    });
    for (const u of testUsers) {
      await supabase.auth.admin.deleteUser(u.id);
      console.log(`Deleted auth user ${u.email}`);
    }
  } catch {
    // Auth cleanup is best-effort.
  }

  console.log(JSON.stringify({ ok: true, testRunId }));
} catch (err) {
  console.error(err);
  process.exit(1);
}
