/**
 * PRP-406 — One-shot Ambika (Ambika Mago / ogambik2@gmail.com) orphan cleanup.
 *
 * Removes payments, ledger lines, rent profiles, leases, and scheduled inbox
 * rows for resident emails that no longer have an application on her account.
 * Does NOT touch property records or `@import.proplane.local` occupancy imports.
 *
 * Named production waiver (cite this file):
 *   docs/waivers/2026-09-07-prp-406-ambika-orphan-resident-cleanup.md
 *
 * Dry-run (default):
 *   node --env-file=.env.production.local \
 *     scripts/cleanup-ambika-orphan-resident-data-production.mjs
 *
 * Apply:
 *   ALLOW_PRODUCTION_AMBIKA_ORPHAN_CLEANUP=1 \
 *   node --env-file=.env.production.local \
 *     scripts/cleanup-ambika-orphan-resident-data-production.mjs --apply
 */

import { createClient } from "@supabase/supabase-js";

const MANAGER_ID = "c49d02b1-7e99-4484-9986-b3b4550c3519";
const MANAGER_EMAIL = "ogambik2@gmail.com";
const PROD_REF = "qahnczmilgptcedaqype";

/** Confirmed orphans from the 2026-09-07 read-only audit (PRP-406). */
const ORPHAN_EMAILS = [
  "saarmedia783@gmail.com",
  "6w2979hwwk@privaterelay.appleid.com",
  "vputta565@gmail.com",
  "jakobpyburn@gmail.com",
  "ntaori@ncsu.edu",
  "narendracheruku18@gmail.com",
  "akshaya.vk25@gmail.com",
];

const APPLY = process.argv.includes("--apply");

function norm(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stripQuotes(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "").trim() : "";
}

const url = stripQuotes(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
const key = stripQuotes(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const ref = url.replace(/^https:\/\/([^.]+).*/, "$1");
if (ref !== PROD_REF) {
  console.error(`Refusing: expected production project ${PROD_REF}, got ${ref}`);
  process.exit(1);
}
if (APPLY && process.env.ALLOW_PRODUCTION_AMBIKA_ORPHAN_CLEANUP !== "1") {
  console.error("Set ALLOW_PRODUCTION_AMBIKA_ORPHAN_CLEANUP=1 with --apply (see docs/waivers/…).");
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const orphanSet = new Set(ORPHAN_EMAILS.map(norm));

async function main() {
  const { data: profile, error: pErr } = await db
    .from("profiles")
    .select("id, email, full_name")
    .eq("id", MANAGER_ID)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!profile || norm(profile.email) !== MANAGER_EMAIL) {
    throw new Error(`Manager identity mismatch: expected ${MANAGER_EMAIL}, got ${profile?.email}`);
  }

  const { data: apps } = await db
    .from("manager_application_records")
    .select("id, resident_email")
    .eq("manager_user_id", MANAGER_ID);
  const activeEmails = new Set((apps ?? []).map((r) => norm(r.resident_email)).filter(Boolean));
  for (const email of orphanSet) {
    if (activeEmails.has(email)) {
      throw new Error(`Safety stop: ${email} still has an application on Ambika's account`);
    }
  }

  const plan = {
    portal_household_charge_records: [],
    portal_recurring_rent_profile_records: [],
    portal_lease_pipeline_records: [],
    ledger_entries: [],
    security_deposit_ledger: [],
    manager_payment_plans: [],
    portal_work_order_records: [],
    portal_service_request_records: [],
    portal_reminder_records: [],
    portal_scheduled_inbox_message_records: [],
    portal_inbox_thread_records: [],
  };

  async function collectEmailTable(table, emailCol) {
    const { data, error } = await db.from(table).select(`id, ${emailCol}`).eq("manager_user_id", MANAGER_ID);
    if (error) {
      console.warn(`${table}: ${error.message}`);
      return;
    }
    for (const row of data ?? []) {
      const email = norm(row[emailCol]);
      if (email && orphanSet.has(email)) plan[table].push({ id: row.id, email });
    }
  }

  await collectEmailTable("portal_household_charge_records", "resident_email");
  await collectEmailTable("portal_recurring_rent_profile_records", "resident_email");
  await collectEmailTable("portal_lease_pipeline_records", "resident_email");
  await collectEmailTable("ledger_entries", "resident_email");
  await collectEmailTable("security_deposit_ledger", "resident_email");
  await collectEmailTable("manager_payment_plans", "resident_email");
  await collectEmailTable("portal_work_order_records", "resident_email");
  await collectEmailTable("portal_service_request_records", "resident_email");

  {
    const { data, error } = await db
      .from("portal_reminder_records")
      .select("id, recipient_email, recipient_role, kind")
      .eq("manager_user_id", MANAGER_ID)
      .eq("recipient_role", "resident");
    if (error) console.warn(`portal_reminder_records: ${error.message}`);
    for (const row of data ?? []) {
      const email = norm(row.recipient_email);
      if (email && orphanSet.has(email)) {
        plan.portal_reminder_records.push({ id: row.id, email, kind: row.kind });
      }
    }
  }

  {
    const { data, error } = await db
      .from("portal_scheduled_inbox_message_records")
      .select("id, row_data")
      .eq("manager_user_id", MANAGER_ID);
    if (error) console.warn(`portal_scheduled_inbox_message_records: ${error.message}`);
    for (const row of data ?? []) {
      const email = norm(row.row_data?.recipientEmail);
      if (email && orphanSet.has(email)) {
        plan.portal_scheduled_inbox_message_records.push({ id: row.id, email });
      }
    }
  }

  {
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .select("id, participant_email")
      .eq("owner_user_id", MANAGER_ID);
    if (error) console.warn(`portal_inbox_thread_records: ${error.message}`);
    for (const row of data ?? []) {
      const email = norm(row.participant_email);
      if (email && orphanSet.has(email)) {
        plan.portal_inbox_thread_records.push({ id: row.id, email });
      }
    }
  }

  const summary = Object.fromEntries(
    Object.entries(plan).map(([table, rows]) => [table, rows.length]),
  );
  const total = Object.values(summary).reduce((a, b) => a + b, 0);

  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", manager: MANAGER_EMAIL, summary, plan }, null, 2));
  console.log(`Total rows: ${total}`);

  if (!APPLY) {
    console.log("Dry-run only. Re-run with --apply and ALLOW_PRODUCTION_AMBIKA_ORPHAN_CLEANUP=1 to delete.");
    return;
  }

  for (const [table, rows] of Object.entries(plan)) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) continue;
    // Chunk to stay under PostgREST URL limits
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { error } = await db.from(table).delete().in("id", chunk);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    console.log(`Deleted ${ids.length} from ${table}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
