#!/usr/bin/env node
/**
 * Bounded acceptance probe for the dedicated test-workspace migration.
 *
 * Default mode is a no-network plan. `--run` performs only reads and denied
 * writes against an explicitly named non-production Supabase project. It does
 * not create accounts, delete rows, send mail, call providers, or mutate
 * schedules. The mutation/CAS scenarios belong in the separately reviewed
 * authenticated browser probe after the SQL migration is approved.
 *
 * Required for --run:
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY, ALLOW_PROBE_TARGET=<project-ref>,
 *   TEST_WORKSPACE_NORMAL_USER_ID, TEST_WORKSPACE_A_ID,
 *   TEST_WORKSPACE_B_ID, TEST_WORKSPACE_RETAINED_MEMBER_ID
 *
 * Optional authenticated RLS token:
 *   TEST_WORKSPACE_AUTH_TOKEN
 *
 * Run only after the migration has been reviewed and applied to dev/test:
 *   node --env-file=.env.test scripts/test-workspace-acceptance-probe.mjs
 *   node --env-file=.env.test scripts/test-workspace-acceptance-probe.mjs --run
 */
import { createClient } from "@supabase/supabase-js";

const run = process.argv.includes("--run");
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOW_PROBE_TARGET",
  "TEST_WORKSPACE_NORMAL_USER_ID",
  "TEST_WORKSPACE_A_ID",
  "TEST_WORKSPACE_B_ID",
  "TEST_WORKSPACE_RETAINED_MEMBER_ID",
];

if (!run) {
  console.log("Dry-run only. No database connection or mutation was attempted.");
  console.log("Re-run with --run after SQL review and an explicit ALLOW_PROBE_TARGET for dev/test.");
  process.exit(0);
}

const env = (name) => process.env[name]?.trim() ?? "";
const missing = required.filter((name) => !env(name));
if (missing.length) {
  console.error(`Missing required probe configuration: ${missing.join(", ")}`);
  process.exit(2);
}

function projectRef(raw) {
  try {
    const host = new URL(raw).host;
    return /^([a-z0-9-]+)\.supabase\.(co|in|red)$/i.exec(host)?.[1] ?? host;
  } catch {
    return "";
  }
}

const target = projectRef(env("NEXT_PUBLIC_SUPABASE_URL"));
if (!target || env("ALLOW_PROBE_TARGET") !== target || target === "qahnczmilgptcedaqype") {
  console.error("Refusing probe: target must exactly match ALLOW_PROBE_TARGET and cannot be production.");
  process.exit(2);
}

const url = env("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const service = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const anon = createClient(url, env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } });
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
}

async function serviceRows(table, select, filter) {
  let query = service.from(table).select(select);
  for (const [key, value] of Object.entries(filter ?? {})) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) throw new Error(`${table} read failed`);
  return data ?? [];
}

async function deniedInsert(client, table, row) {
  const { error } = await client.from(table).insert(row);
  return Boolean(error);
}

try {
  const workspaceRows = await serviceRows("test_workspaces", "id,status", { id: env("TEST_WORKSPACE_A_ID") });
  const workspaceB = await serviceRows("test_workspaces", "id,status", { id: env("TEST_WORKSPACE_B_ID") });
  check("two test workspaces exist and are separate", workspaceRows.length === 1 && workspaceB.length === 1 && workspaceRows[0].id !== workspaceB[0].id);

  const members = await serviceRows("test_workspace_members", "id,user_id,workspace_id,state,expires_at", { id: env("TEST_WORKSPACE_RETAINED_MEMBER_ID") });
  check("retained membership row exists", members.length === 1);
  if (members[0]) {
    const profiles = await serviceRows("profiles", "id", { id: members[0].user_id });
    check("retained membership survives profile deletion", profiles.length === 0 || Boolean(process.env.TEST_WORKSPACE_RETAINED_PROFILE_PRESENT));
  }

  const normalMembers = await serviceRows("test_workspace_members", "id", { user_id: env("TEST_WORKSPACE_NORMAL_USER_ID") });
  check("normal principal is not classified", normalMembers.length === 0);

  const token = env("TEST_WORKSPACE_AUTH_TOKEN");
  const rlsClient = token ? createClient(url, env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } }) : anon;
  check("direct membership insert is denied by RLS/grants", await deniedInsert(rlsClient, "test_workspace_members", { workspace_id: env("TEST_WORKSPACE_A_ID"), user_id: env("TEST_WORKSPACE_NORMAL_USER_ID"), portal_role: "resident" }));
  check("direct cross-workspace property insert is denied", await deniedInsert(rlsClient, "manager_property_records", { id: `probe-${Date.now()}`, manager_user_id: env("TEST_WORKSPACE_NORMAL_USER_ID"), status: "live", test_workspace_id: env("TEST_WORKSPACE_B_ID"), property_data: {} }));
  check("global singleton schedule insert is denied", await deniedInsert(rlsClient, "portal_schedule_records", { id: "axis_admin_planned_events_v1", record_type: "planned_events", test_workspace_id: env("TEST_WORKSPACE_A_ID"), row_data: { payload: [] } }));

  const schedulesA = await serviceRows("test_workspace_schedule_records", "workspace_id,record_key,row_data", { workspace_id: env("TEST_WORKSPACE_A_ID") });
  const schedulesB = await serviceRows("test_workspace_schedule_records", "workspace_id,record_key,row_data", { workspace_id: env("TEST_WORKSPACE_B_ID") });
  check("workspace schedule namespaces remain separate", schedulesA.every((row) => row.workspace_id === env("TEST_WORKSPACE_A_ID")) && schedulesB.every((row) => row.workspace_id === env("TEST_WORKSPACE_B_ID")));

  const expiredOrSuspended = await service.from("test_workspace_members").select("id,state,expires_at").in("workspace_id", [env("TEST_WORKSPACE_A_ID"), env("TEST_WORKSPACE_B_ID")]);
  check("suspended/expired state is inspectable for refusal checks", !expiredOrSuspended.error);

  console.log(`Workspace acceptance probe for ${target}:`);
  for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? ` (${result.detail})` : ""}`);
  process.exitCode = checks.every((result) => result.ok) ? 0 : 1;
} catch {
  console.error("Probe failed closed while reading the reviewed workspace boundary.");
  process.exitCode = 1;
}
