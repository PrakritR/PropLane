#!/usr/bin/env node
/**
 * Deletes Supabase auth users that have the manager role but are not admins and not on the keep list.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same as ensure-admin-account.mjs).
 *
 * Dry run (default — prints who would be deleted):
 *   node --env-file=.env scripts/purge-non-demo-managers.mjs
 *
 * Execute deletes:
 *   CONFIRM_PURGE=yes node --env-file=.env scripts/purge-non-demo-managers.mjs
 *
 * Keep additional manager emails (comma-separated, lowercased automatically):
 *   AXIS_KEEP_MANAGER_EMAILS="one@company.com,two@company.com" CONFIRM_PURGE=yes node --env-file=.env scripts/purge-non-demo-managers.mjs
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const confirm = process.env.CONFIRM_PURGE === "yes";

const defaultDemoKeep = [
  "akhil-manager@prop-lane.space",
  "demo.manager@example.com",
  "manager.demo@example.com",
  "alex.manager@example.com",
];

const extraKeep = (process.env.AXIS_KEEP_MANAGER_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const keepEmails = new Set([...defaultDemoKeep.map((e) => e.toLowerCase()), ...extraKeep]);

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: adminRoleRows, error: adminErr } = await supabase.from("profile_roles").select("user_id").eq("role", "admin");
if (adminErr) {
  console.error("profile_roles admin:", adminErr.message);
  process.exit(1);
}
const adminIds = new Set((adminRoleRows ?? []).map((r) => r.user_id));

const { data: managerRoleRows } = await supabase.from("profile_roles").select("user_id").eq("role", "manager");
const idsFromRoles = [...new Set((managerRoleRows ?? []).map((r) => r.user_id))];

const { data: legacyRows } = await supabase.from("profiles").select("id").eq("role", "manager");
const legacyIds = (legacyRows ?? []).map((p) => p.id);
const managerIds = [...new Set([...idsFromRoles, ...legacyIds])].filter((id) => !adminIds.has(id));

if (managerIds.length === 0) {
  console.log("No manager accounts found (excluding admins). Nothing to do.");
  process.exit(0);
}

const { data: profiles, error: profErr } = await supabase
  .from("profiles")
  .select("id, email, full_name")
  .in("id", managerIds);

if (profErr) {
  console.error("profiles:", profErr.message);
  process.exit(1);
}

const toDelete = [];
const toKeep = [];

for (const p of profiles ?? []) {
  const em = (p.email ?? "").trim().toLowerCase();
  if (keepEmails.has(em)) {
    toKeep.push({ id: p.id, email: p.email, name: p.full_name });
  } else {
    toDelete.push({ id: p.id, email: p.email, name: p.full_name });
  }
}

console.log(`Managers on keep list (${toKeep.length}):`);
for (const r of toKeep) console.log(`  keep  ${r.email ?? r.id}  (${r.name ?? "—"})`);

console.log(`\nWould delete (${toDelete.length}) manager account(s) not on keep list and not admin:`);
for (const r of toDelete) console.log(`  delete ${r.email ?? r.id}  (${r.name ?? "—"})`);

if (toDelete.length === 0) {
  process.exit(0);
}

if (!confirm) {
  console.error("\nDry run only. Set CONFIRM_PURGE=yes to delete these users from Supabase Auth.");
  process.exit(2);
}

for (const r of toDelete) {
  const { error } = await supabase.auth.admin.deleteUser(r.id);
  if (error) {
    console.error("deleteUser failed:", r.id, error.message);
    process.exit(1);
  }
  console.log("Deleted:", r.email ?? r.id);
}

console.log("Done.");
