#!/usr/bin/env node
/**
 * One-off: set Supabase password + profiles/profile_roles for the sole admin user.
 * Requires SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL in the environment.
 *
 * Usage (from repo root, with .env loaded):
 *   node --env-file=.env scripts/ensure-admin-account.mjs prakritramachandran@gmail.com 'YourPasswordHere'
 *
 * Promote primary admin + strip admin from all other accounts (no password change):
 *   node --env-file=.env scripts/ensure-admin-account.mjs --roles-only
 *
 * Or:
 *   EMAIL=x PASSWORD=y node --env-file=.env scripts/ensure-admin-account.mjs
 */

import { createClient } from "@supabase/supabase-js";

/** Keep in sync with src/lib/auth/primary-admin.ts */
const PRIMARY_ADMIN_EMAIL = "prakritramachandran@gmail.com";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const rolesOnly = args.includes("--roles-only");
const positional = args.filter((arg) => arg !== "--roles-only");
const emailArg = positional[0]?.trim();
const passwordArg = positional[1];
const email = (emailArg || process.env.EMAIL || PRIMARY_ADMIN_EMAIL).trim().toLowerCase();
const password = passwordArg ?? process.env.PASSWORD ?? "";

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (email !== PRIMARY_ADMIN_EMAIL) {
  console.error(`Only ${PRIMARY_ADMIN_EMAIL} can be the Axis admin account.`);
  process.exit(1);
}
if (!rolesOnly && (!password || password.length < 8)) {
  console.error("Usage: node --env-file=.env scripts/ensure-admin-account.mjs <email> <password>");
  console.error("       node --env-file=.env scripts/ensure-admin-account.mjs --roles-only");
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function normEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function findUserByEmail(targetEmail) {
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr || !listData?.users?.length) {
    throw new Error(listErr?.message ?? "no users");
  }
  return listData.users.find((u) => normEmail(u.email) === targetEmail) ?? null;
}

async function demoteOtherAdmins(primaryUserId) {
  const { data: adminRoleRows, error: adminErr } = await supabase
    .from("profile_roles")
    .select("user_id")
    .eq("role", "admin");
  if (adminErr) {
    throw new Error(`profile_roles admin: ${adminErr.message}`);
  }

  const otherAdminIds = [...new Set((adminRoleRows ?? []).map((row) => row.user_id).filter((id) => id !== primaryUserId))];
  if (otherAdminIds.length) {
    const { error: delRolesErr } = await supabase
      .from("profile_roles")
      .delete()
      .eq("role", "admin")
      .in("user_id", otherAdminIds);
    if (delRolesErr) {
      throw new Error(`profile_roles delete: ${delRolesErr.message}`);
    }
  }

  const { data: legacyAdmins, error: legacyErr } = await supabase
    .from("profiles")
    .select("id, email, role")
    .eq("role", "admin")
    .neq("id", primaryUserId);
  if (legacyErr) {
    throw new Error(`profiles admin lookup: ${legacyErr.message}`);
  }

  for (const profile of legacyAdmins ?? []) {
    const { data: roles } = await supabase.from("profile_roles").select("role").eq("user_id", profile.id);
    const nextRole =
      (roles ?? [])
        .map((row) => String(row.role ?? "").toLowerCase())
        .find((role) => role && role !== "admin") ?? "manager";
    const { error: updErr } = await supabase.from("profiles").update({ role: nextRole }).eq("id", profile.id);
    if (updErr) {
      throw new Error(`profiles demote ${profile.email ?? profile.id}: ${updErr.message}`);
    }
    console.log("Demoted legacy admin profile:", profile.email ?? profile.id, "→", nextRole);
  }

  if (otherAdminIds.length || (legacyAdmins ?? []).length) {
    console.log("Removed admin access from non-primary accounts.");
  } else {
    console.log("No extra admin accounts found.");
  }
}

async function promotePrimaryAdmin(userId) {
  const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();

  const { error: pErr } = await supabase.from("profiles").upsert(
    {
      id: userId,
      email: PRIMARY_ADMIN_EMAIL,
      role: "admin",
      manager_id: existingProfile?.manager_id ?? null,
      full_name: existingProfile?.full_name ?? null,
      application_approved: existingProfile?.application_approved ?? true,
    },
    { onConflict: "id" },
  );
  if (pErr) {
    throw new Error(`profiles upsert: ${pErr.message}`);
  }

  const { error: rErr } = await supabase.from("profile_roles").upsert(
    { user_id: userId, role: "admin" },
    { onConflict: "user_id,role" },
  );
  if (rErr) {
    throw new Error(`profile_roles upsert: ${rErr.message}`);
  }

  const { error: managerRoleErr } = await supabase.from("profile_roles").upsert(
    { user_id: userId, role: "manager" },
    { onConflict: "user_id,role" },
  );
  if (managerRoleErr) {
    throw new Error(`profile_roles manager upsert: ${managerRoleErr.message}`);
  }
}

let userId;

if (rolesOnly) {
  const existing = await findUserByEmail(email);
  if (!existing) {
    console.error(`No auth user found for ${email}. Run without --roles-only and provide a password to create the account.`);
    process.exit(1);
  }
  userId = existing.id;
  console.log("Syncing admin roles for existing user:", email);
} else {
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: "admin" },
  });

  if (createErr) {
    const msg = createErr.message.toLowerCase();
    const exists = msg.includes("already") || msg.includes("registered");
    if (!exists) {
      console.error("createUser:", createErr.message);
      process.exit(1);
    }
    const existing = await findUserByEmail(email);
    if (!existing) {
      console.error("User exists but could not be found in first 1000 users. Add via Supabase Dashboard.");
      process.exit(1);
    }
    userId = existing.id;
    const { error: updErr } = await supabase.auth.admin.updateUserById(userId, { password });
    if (updErr) {
      console.error("updateUserById:", updErr.message);
      process.exit(1);
    }
    console.log("Updated password for existing user:", email);
  } else {
    if (!created.user) {
      console.error("No user returned from createUser.");
      process.exit(1);
    }
    userId = created.user.id;
    console.log("Created user:", email);
  }
}

try {
  await promotePrimaryAdmin(userId);
  await demoteOtherAdmins(userId);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log("Admin role synced on profiles + profile_roles. You can sign in at /auth/sign-in");
