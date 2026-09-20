#!/usr/bin/env node
/**
 * Keep only the canonical manager + resident accounts; delete everything else.
 *
 * Dry run (default):
 *   node --env-file=.env scripts/purge-extra-portal-accounts.mjs
 *
 * Execute:
 *   CONFIRM_PURGE=yes node --env-file=.env scripts/purge-extra-portal-accounts.mjs
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const confirm = process.env.CONFIRM_PURGE === "yes";

/** Keep in sync with src/lib/auth/primary-admin.ts and ensure-admin-account.mjs. */
const PRIMARY_ADMIN_EMAIL = "founders@axis-seattle-housing.com";

/**
 * The sole ops admin (src/lib/auth/primary-admin.ts). It is admin-ONLY: it must
 * never be carried in the manager or resident keep-lists, or a purge run would
 * imply it is a portal account of that kind. Kept here so the purge never
 * deletes it.
 */
const KEEP_ADMIN_EMAILS = new Set([PRIMARY_ADMIN_EMAIL]);

/** Canonical manager accounts (property portal). */
const KEEP_MANAGER_EMAILS = new Set(
  [
    "akhil-manager@prop-lane.space",
    "akhilthebest23@gmail.com",
    "hiteshkjm@gmail.com",
    "ocenedella@gmail.com",
    "prakritramachandran@gmail.com",
    ...(process.env.AXIS_KEEP_MANAGER_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ].map((e) => e.toLowerCase()),
);

/** Canonical resident accounts. */
const KEEP_RESIDENT_EMAILS = new Set(
  [
    "akhil-resident@prop-lane.space",
    "maya.chen.akhil@test.proplane.local",
    "marcus.lee.akhil@test.proplane.local",
    "sofia.diaz.akhil@test.proplane.local",
    "liam.foster.akhil@test.proplane.local",
    "olivia.brooks.akhil@test.proplane.local",
    "arnavjs78@gmail.com",
    "connorgrome89@gmail.com",
    "davidhyoo1@gmail.com",
    "davidmacaraig@gmail.com",
    "jewook.parkden@gmail.com",
    "juandacalle82@gmail.com",
    "kavinu.753@gmail.com",
    "ryan.d.gribble@gmail.com",
    "tatvapra@usc.edu",
    "wbtaylor002@gmail.com",
    ...(process.env.AXIS_KEEP_RESIDENT_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ].map((e) => e.toLowerCase()),
);

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function normEmail(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

async function idsForRole(role) {
  const { data: pr } = await supabase.from("profile_roles").select("user_id").eq("role", role);
  const fromRoles = [...new Set((pr ?? []).map((r) => r.user_id))];
  const { data: legacy } = await supabase.from("profiles").select("id").eq("role", role);
  const fromLegacy = (legacy ?? []).map((p) => p.id);
  return [...new Set([...fromRoles, ...fromLegacy])];
}

async function loadProfiles(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, manager_id, role")
    .in("id", ids);
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function loadRoles(userId) {
  const { data } = await supabase.from("profile_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => String(r.role ?? "").toLowerCase()).filter(Boolean);
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  const legacy = String(profile?.role ?? "").toLowerCase();
  if (legacy && !roles.includes(legacy)) roles.push(legacy);
  return [...new Set(roles)];
}

async function purgeManagerPortalData(managerUserId) {
  const results = await Promise.all([
    supabase.from("manager_property_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("manager_application_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_household_charge_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_recurring_rent_profile_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_lease_pipeline_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_work_order_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_inbox_thread_records").delete().eq("owner_user_id", managerUserId),
    supabase.from("portal_schedule_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_pro_relationship_records").delete().eq("manager_user_id", managerUserId),
    supabase.from("portal_pro_relationship_records").delete().eq("related_user_id", managerUserId),
    supabase.from("account_link_invites").delete().eq("inviter_user_id", managerUserId),
    supabase.from("account_link_invites").delete().eq("invitee_user_id", managerUserId),
    supabase.from("portal_bug_feedback_records").delete().eq("reporter_user_id", managerUserId),
    supabase.from("manager_purchases").delete().eq("user_id", managerUserId),
  ]);
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
}

async function purgeResidentPortalData({ email, userId }) {
  const ops = [];
  if (email) {
    ops.push(
      supabase.from("portal_household_charge_records").delete().eq("resident_email", email),
      supabase.from("portal_recurring_rent_profile_records").delete().eq("resident_email", email),
      supabase.from("portal_lease_pipeline_records").delete().eq("resident_email", email),
      supabase.from("portal_work_order_records").delete().eq("resident_email", email),
      supabase.from("portal_inbox_thread_records").delete().eq("participant_email", email),
      supabase.from("portal_outbound_mail_records").delete().eq("recipient_email", email),
      supabase.from("portal_resident_lease_upload_records").delete().eq("resident_email", email),
      supabase.from("manager_application_records").delete().eq("resident_email", email),
      supabase.from("portal_bug_feedback_records").delete().eq("reporter_email", email),
    );
  }
  if (userId) {
    ops.push(
      supabase.from("portal_household_charge_records").delete().eq("resident_user_id", userId),
      supabase.from("portal_recurring_rent_profile_records").delete().eq("resident_user_id", userId),
      supabase.from("portal_lease_pipeline_records").delete().eq("resident_user_id", userId),
      supabase.from("portal_resident_lease_upload_records").delete().eq("resident_user_id", userId),
      supabase.from("portal_bug_feedback_records").delete().eq("reporter_user_id", userId),
    );
  }
  if (!ops.length) return;
  const results = await Promise.all(ops);
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
}

async function removePortalRole(userId, roleToRemove) {
  const roles = await loadRoles(userId);
  if (!roles.includes(roleToRemove)) return "no_role";

  const remaining = roles.filter((r) => r !== roleToRemove);
  if (remaining.length === 0) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return "deleted_auth_user";
  }

  const { error: removeErr } = await supabase
    .from("profile_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role", roleToRemove);
  if (removeErr) throw new Error(removeErr.message);

  const nextRole = remaining.includes("admin")
    ? "admin"
    : remaining.includes("manager")
      ? "manager"
      : remaining.includes("pro")
        ? "pro"
        : remaining.includes("resident")
          ? "resident"
          : remaining[0];

  const patch = { role: nextRole, updated_at: new Date().toISOString() };
  if (roleToRemove === "resident") patch.application_approved = false;
  const { error: upErr } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (upErr) throw new Error(upErr.message);
  return "revoked_role";
}

async function deleteManagerAccount(userId) {
  await purgeManagerPortalData(userId);
  return removePortalRole(userId, "manager");
}

async function deleteResidentAccount(userId, email) {
  await purgeResidentPortalData({ email, userId });
  const roles = await loadRoles(userId);
  const protectedRoles = new Set(["admin", "manager", "pro"]);
  if (roles.some((r) => protectedRoles.has(r))) {
    return removePortalRole(userId, "resident");
  }
  if (!userId) return "no_user";
  const { error: roleDelErr } = await supabase.from("profile_roles").delete().eq("user_id", userId);
  if (roleDelErr) throw new Error(roleDelErr.message);
  const { error: profDelErr } = await supabase.from("profiles").delete().eq("id", userId);
  if (profDelErr) throw new Error(profDelErr.message);
  const { error: authDelErr } = await supabase.auth.admin.deleteUser(userId);
  if (authDelErr) throw new Error(authDelErr.message);
  return "deleted_auth_user";
}

async function purgeStaleAccountLinks(keepUserIds) {
  const { data: links, error } = await supabase.from("account_link_invites").select("id, inviter_user_id, invitee_user_id, invitee_display_name, inviter_display_name, status");
  if (error) {
    if (String(error.message).toLowerCase().includes("account_link_invites")) return { deleted: 0 };
    throw new Error(error.message);
  }

  const stale = (links ?? []).filter(
    (row) => !keepUserIds.has(row.inviter_user_id) || !keepUserIds.has(row.invitee_user_id),
  );

  if (!stale.length) return { deleted: 0, stale: [] };

  const ids = stale.map((r) => r.id);
  if (confirm) {
    const { error: delErr } = await supabase.from("account_link_invites").delete().in("id", ids);
    if (delErr) throw new Error(delErr.message);
  }
  return { deleted: stale.length, stale };
}

// ── Main ──

const { data: adminRoleRows } = await supabase.from("profile_roles").select("user_id").eq("role", "admin");
const adminIds = new Set((adminRoleRows ?? []).map((r) => r.user_id));

const managerIds = (await idsForRole("manager")).filter((id) => !adminIds.has(id));
const residentIds = await idsForRole("resident");

const managerProfiles = await loadProfiles(managerIds);
const residentProfiles = await loadProfiles(residentIds);

// The ops admin is admin-only and is already excluded from managerIds via
// adminIds, but guard by email too: if it ever wrongly picks up a manager or
// resident role row, the purge must still never delete it.
const isAdminEmail = (p) => KEEP_ADMIN_EMAILS.has(normEmail(p.email));

const managersToDelete = managerProfiles.filter((p) => !KEEP_MANAGER_EMAILS.has(normEmail(p.email)) && !isAdminEmail(p));
const managersToKeep = managerProfiles.filter((p) => KEEP_MANAGER_EMAILS.has(normEmail(p.email)) || isAdminEmail(p));
const residentsToDelete = residentProfiles.filter((p) => !KEEP_RESIDENT_EMAILS.has(normEmail(p.email)) && !isAdminEmail(p));
const residentsToKeep = residentProfiles.filter((p) => KEEP_RESIDENT_EMAILS.has(normEmail(p.email)) || isAdminEmail(p));

const keepUserIds = new Set([
  ...adminIds,
  ...managersToKeep.map((p) => p.id),
  ...residentsToKeep.map((p) => p.id),
]);

console.log("=== Keep managers ===");
for (const p of managersToKeep) console.log(`  ${p.email}  ${p.full_name ?? ""}  ${p.manager_id ?? ""}`);
console.log(`\n=== Keep residents (${residentsToKeep.length}) ===`);
for (const p of residentsToKeep) console.log(`  ${p.email}  ${p.full_name ?? ""}`);

console.log(`\n=== Delete managers (${managersToDelete.length}) ===`);
for (const p of managersToDelete) console.log(`  ${p.email}  ${p.full_name ?? ""}  ${p.manager_id ?? ""}`);

console.log(`\n=== Delete residents (${residentsToDelete.length}) ===`);
for (const p of residentsToDelete) console.log(`  ${p.email}  ${p.full_name ?? ""}`);

const linkResult = await purgeStaleAccountLinks(keepUserIds);
console.log(`\n=== Stale account links (${linkResult.deleted}) ===`);
for (const row of linkResult.stale ?? []) {
  console.log(`  ${row.inviter_display_name ?? row.inviter_user_id} ↔ ${row.invitee_display_name ?? row.invitee_user_id}  [${row.status}]`);
}

const totalDeletes = managersToDelete.length + residentsToDelete.length;
if (totalDeletes === 0 && linkResult.deleted === 0) {
  console.log("\nNothing to delete.");
  process.exit(0);
}

if (!confirm) {
  console.error("\nDry run only. Set CONFIRM_PURGE=yes to delete.");
  process.exit(2);
}

console.log("\nDeleting…");

for (const p of managersToDelete) {
  const mode = await deleteManagerAccount(p.id);
  console.log(`Deleted manager ${p.email} (${mode})`);
}

for (const p of residentsToDelete) {
  const mode = await deleteResidentAccount(p.id, normEmail(p.email));
  console.log(`Deleted resident ${p.email} (${mode})`);
}

console.log("\nDone.");
