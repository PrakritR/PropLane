#!/usr/bin/env node
/**
 * "Are the QA accounts usable right now?" — in one command.
 *
 * PRP-198: `manager@test.proplane.local` was documented as fact, a dev reset had
 * removed it, and signing in returned "Invalid login credentials" — the same
 * message a wrong password gives. Establishing which it was took a direct
 * database query. This asserts, for every canonical account: the auth user
 * exists, its email is confirmed, it carries the expected role, and it can
 * ACTUALLY sign in. Nothing is inferred from the others — a confirmed user with
 * a rotated password still fails the sign-in column.
 *
 *   npm run test:accounts:check
 *
 * Reads the SAME credentials every spec and QA script reads
 * (tests/fixtures/qa-accounts.mjs), so a `.env.test` that disagrees with the
 * docs shows up here instead of as a mystery failure three layers down.
 */
import { createClient } from "@supabase/supabase-js";

import { QA_ACCOUNTS } from "../tests/fixtures/qa-accounts.mjs";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ANON =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!URL || !ANON) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.\n" +
      "  Run through the package script so the env file is loaded:\n" +
      "    npm run test:accounts:check\n" +
      "  A fresh worktree has no env files at all — seed them first: npm run seed:env",
  );
  process.exit(1);
}

/** Guard rail: this signs in as real users, so it must never run against production. */
const PRODUCTION_HINTS = ["prop-lane.space", "axis-seattle-housing.com"];
if (PRODUCTION_HINTS.some((h) => URL.includes(h))) {
  console.error(`Refusing to run against what looks like production: ${URL}`);
  process.exit(1);
}

const admin = SERVICE ? createClient(URL, SERVICE, { auth: { persistSession: false } }) : null;

/** Roles from `profile_roles` (the multi-role source of truth), falling back to the legacy column. */
async function rolesFor(userId) {
  if (!admin) return null;
  const { data, error } = await admin.from("profile_roles").select("role").eq("user_id", userId);
  if (error) return null;
  const roles = (data ?? []).map((r) => String(r.role));
  if (roles.length > 0) return roles;
  const { data: profile } = await admin.from("profiles").select("role").eq("id", userId).maybeSingle();
  return profile?.role ? [String(profile.role)] : [];
}

async function findAuthUser(email) {
  if (!admin) return undefined;
  // listUsers is paginated; the QA project is small, but page until found.
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return undefined;
    const users = data?.users ?? [];
    const hit = users.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

const rows = [];
let failures = 0;

for (const account of Object.values(QA_ACCOUNTS)) {
  const row = {
    account: account.key,
    email: account.email,
    exists: "?",
    confirmed: "?",
    role: "?",
    signIn: "—",
    note: "",
  };

  const authUser = await findAuthUser(account.email);
  if (authUser === undefined) {
    row.exists = "?";
    row.note = "no service-role key — existence not checked";
  } else if (authUser === null) {
    row.exists = "NO";
    row.confirmed = "—";
    row.role = "—";
    row.note = "account does not exist";
  } else {
    row.exists = "yes";
    row.confirmed = authUser.email_confirmed_at ? "yes" : "NO";
    const roles = await rolesFor(authUser.id);
    if (roles === null) {
      row.role = "?";
    } else if (roles.includes(account.role)) {
      row.role = roles.join("+");
    } else {
      row.role = `${roles.join("+") || "none"} (want ${account.role})`;
      row.note = row.note || `missing the ${account.role} role`;
    }
  }

  // The authoritative column: everything above can look right and sign-in still fail.
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (signInError || !signIn?.session) {
    row.signIn = "NO";
    row.note = row.note || signInError?.message || "sign-in returned no session";
  } else {
    row.signIn = "yes";
    await client.auth.signOut().catch(() => {});
  }

  const bad =
    row.exists === "NO" ||
    row.confirmed === "NO" ||
    row.signIn === "NO" ||
    row.role.includes("want ");
  if (bad) failures += 1;
  rows.push(row);
}

const headers = ["account", "email", "exists", "confirmed", "role", "signIn", "note"];
const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => String(r[h]).length)));
const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");

console.log(`QA accounts on ${URL}\n`);
console.log(line(headers));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) console.log(line(headers.map((h) => row[h])));

if (!admin) {
  console.log("\nNote: SUPABASE_SERVICE_ROLE_KEY not set — only the sign-in column was verified.");
}

if (failures > 0) {
  console.error(
    `\n${failures} QA account(s) unusable.\n` +
      "  Seed them:  npm run test:seed        (dev/test project, from .env.test)\n" +
      "  Or for the local dev project:  npm run seed:dev\n" +
      "  If the password is what changed, the canonical values live in tests/fixtures/qa-accounts.mjs\n" +
      "  and are overridden by E2E_*_EMAIL / E2E_*_PASSWORD.",
  );
  process.exit(1);
}

console.log("\nAll QA accounts exist, are confirmed, carry their role, and can sign in.");
