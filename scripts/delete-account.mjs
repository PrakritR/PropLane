/**
 * Delete an account and everything it owns.
 *
 * There was no code path that could do this. Doing it by hand meant discovering the foreign-key
 * order the hard way and writing deletes across roughly forty tables — which is both a routine
 * data-protection request the product could not honour, and a chore re-derived on every QA reset.
 *
 * Usage:
 *   ALLOW_DELETE_TARGET=<project-ref> node --env-file=.env scripts/delete-account.mjs <email> [flags]
 *
 * Flags:
 *   --dry-run       print the plan and touch nothing (default when neither --dry-run nor --yes)
 *   --yes           actually delete; without it the script always stops after printing
 *   --keep-login    empty the account's data but leave auth.users / profiles / profile_roles
 *                   (the "blank slate for QA" case)
 *
 * Exit 0 = done (or plan printed). 1 = something remained. 2 = misconfigured or refused.
 *
 * WHY THE TARGET GUARD. This deletes real rows and cannot be undone. The script runs against
 * whatever `NEXT_PUBLIC_SUPABASE_URL` is in the environment, and a doc comment is not a control,
 * so `ALLOW_DELETE_TARGET` must name the project ref explicitly — the same shape
 * `verify-role-escalation-closed.mjs` uses. Confirm it is not production first; see
 * docs/database-environments.md, where production's credentials deliberately live only in Vercel.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

import {
  DELETE_ORDER,
  EMAIL_COLUMNS,
  ID_COLUMNS,
  IDENTITY_TABLES,
  ownershipFilter,
  targetFromUrl,
} from "./lib/account-deletion.mjs";

const target = targetFromUrl(url);
const allowed = process.env.ALLOW_DELETE_TARGET?.trim() ?? "";

if (!target || allowed !== target) {
  console.error(
    `Refusing to run: this script permanently deletes rows and cannot be undone.\n` +
      `Set ALLOW_DELETE_TARGET to the project it should touch, and confirm it is NOT production first.\n` +
      `  NEXT_PUBLIC_SUPABASE_URL resolves to target: ${target || "(unparseable)"}\n` +
      `  ALLOW_DELETE_TARGET is currently: ${allowed || "(unset)"}`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase() ?? "";
const apply = args.includes("--yes");
const keepLogin = args.includes("--keep-login");

if (!email.includes("@")) {
  console.error("Usage: ALLOW_DELETE_TARGET=<ref> node --env-file=.env scripts/delete-account.mjs <email> [--yes] [--keep-login]");
  process.exit(2);
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, contentRange: res.headers.get("content-range") };
}



/** Which of our scoping columns this table actually has — asked once, from the table itself. */
async function scopingColumnsFor(table) {
  const probe = await rest(`${table}?select=*&limit=1`);
  if (!probe.ok) return null;
  const sample = Array.isArray(probe.body) ? probe.body[0] : null;
  if (!sample) {
    // An empty table tells us nothing about its columns, and probing each candidate one at a
    // time is cheap compared with deleting the wrong thing. Ask PostgREST per column.
    const present = [];
    for (const col of [...ID_COLUMNS, ...EMAIL_COLUMNS]) {
      const r = await rest(`${table}?select=${col}&limit=1`);
      if (r.ok) present.push(col);
    }
    return present;
  }
  return [...ID_COLUMNS, ...EMAIL_COLUMNS].filter((c) => c in sample);
}

async function main() {
  const found = await rest(`profiles?select=id,email&email=eq.${encodeURIComponent(email)}`);
  const profile = Array.isArray(found.body) ? found.body[0] : null;
  const userId = profile?.id ?? null;

  if (!userId) {
    console.log(`No profile for ${email}. Rows keyed on the email alone will still be listed.`);
  }

  console.log(`\nTarget project: ${target}`);
  console.log(`Account: ${email}${userId ? ` (${userId})` : " (no profile row)"}`);
  console.log(apply ? "Mode: DELETE" : "Mode: dry run — nothing will be written");
  console.log(keepLogin ? "Login: kept (data only)" : "Login: removed with the data\n");

  const plan = [];
  for (const table of DELETE_ORDER) {
    const columns = await scopingColumnsFor(table);
    if (columns === null) continue; // table not in this schema
    const filter = ownershipFilter(columns, { userId, email });
    if (!filter) continue;
    const counted = await rest(`${table}?select=*&${filter}`, { headers: { Prefer: "count=exact", Range: "0-0" } });
    const total = Number(counted.contentRange?.split("/")?.[1] ?? 0);
    if (total > 0) plan.push({ table, filter, total, columns });
  }

  if (plan.length === 0) {
    console.log("Nothing to delete — no rows reference this account by any scoping column.");
  }
  for (const step of plan) {
    console.log(`  ${String(step.total).padStart(6)}  ${step.table}  (${step.columns.join(", ")})`);
  }
  console.log(`\n  ${plan.reduce((n, s) => n + s.total, 0)} rows across ${plan.length} tables`);

  if (!apply) {
    console.log("\nRe-run with --yes to delete. Nothing was written.");
    return 0;
  }

  for (const step of plan) {
    const res = await rest(`${step.table}?${step.filter}`, { method: "DELETE" });
    if (!res.ok) {
      console.error(`FAILED on ${step.table}: ${res.status} ${JSON.stringify(res.body)}`);
      console.error("Stopped here on purpose — a partial delete in a known order is recoverable; continuing past a foreign-key refusal is not.");
      return 1;
    }
    console.log(`  deleted  ${step.table}`);
  }

  if (!keepLogin && userId) {
    for (const table of IDENTITY_TABLES) {
      await rest(`${table}?${table === "profiles" ? "id" : "user_id"}=eq.${userId}`, { method: "DELETE" });
    }
    const authRes = await fetch(`${url}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers });
    if (!authRes.ok) {
      console.error(`Auth user delete failed: ${authRes.status} ${await authRes.text()}`);
      return 1;
    }
    console.log("  deleted  auth.users");
  }

  // Verification, not a claim: re-count every table rather than trusting the deletes reported.
  let remaining = 0;
  for (const step of plan) {
    const check = await rest(`${step.table}?select=*&${step.filter}`, { headers: { Prefer: "count=exact", Range: "0-0" } });
    const left = Number(check.contentRange?.split("/")?.[1] ?? 0);
    if (left > 0) {
      console.error(`  ${left} rows STILL reference this account in ${step.table}`);
      remaining += left;
    }
  }
  console.log(remaining === 0 ? "\nDone — zero rows reference this account." : `\n${remaining} rows remain.`);
  return remaining === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
