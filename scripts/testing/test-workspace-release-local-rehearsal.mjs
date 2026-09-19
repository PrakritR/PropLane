#!/usr/bin/env node
/** Actual staging schema, synthetic auth, no customer rows, no cloud connection path. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { getHeapStatistics } from "node:v8";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildAtomicBundle, ledgerRowDigest, reviewedMigrations, sha256, validateSnapshot, TARGETS } from "../prepare-test-workspace-release-migrations.mjs";

const BACKUP_DIR = "/Users/akhilvemuri/.local/state/proplane-release-backups/20260919-staging-test-workspace";
const SCHEMA_SHA = "5ef79f5aec15630bc1fa8ee032902a7e70fde7d7dd267bb1d1e7cce85621da3d";
const CAPTURE_SHA = "e5e5e21ecb5fc317f551b23108258e48b36d9c09b2a75654162a7852f1abcabd";
const BIN = "/opt/homebrew/bin/";
const ROLE_NAMES = Object.freeze(["anon", "authenticated", "service_role", "dashboard_user", "supabase_admin", "supabase_storage_admin"]);
const LOCAL_DB = "test_workspace_rehearsal";
const LOCAL_BACKUP_SHA = sha256(JSON.stringify({ purpose: "local-only-rehearsal", schema: SCHEMA_SHA, capture: CAPTURE_SHA }));
const BARRIER = "20260919124501";
let phase = "input";
let interrupted = false;
let cluster;
let cleanupPromise;
const clients = new Set();
const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function ensureActive() { if (interrupted) throw new Error("REHEARSAL interrupted"); }
function identifier(value) { assert.match(value, /^[a-z][a-z0-9_]*$/); return `"${value}"`; }
function run(binary, args, options = {}) {
  ensureActive();
  return execFileSync(binary, args, { encoding: "utf8", stdio: "pipe", timeout: 45_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" }, ...options });
}

/** Only pg_dump's random restriction envelope is removable. Everything else is restored unchanged. */
function stripRestrictionCommands(sql) {
  return sql.split("\n").filter((line) => {
    if (/^\\(?:un)?restrict\s+\S+\s*$/.test(line)) return false;
    if (/^\s*\\/.test(line)) throw new Error("REHEARSAL unexpected psql metacommand");
    return true;
  }).join("\n");
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function ownedPostmaster() {
  const marker = JSON.parse(readFileSync(join(cluster.directory, "owner.json"), "utf8"));
  assert.equal(marker.token, cluster.token);
  assert.equal(marker.ownerPid, process.pid);
  assert.equal(realpathSync(cluster.dataDirectory), marker.dataDirectory);
  const pidFile = join(cluster.dataDirectory, "postmaster.pid");
  if (!existsSync(pidFile)) return null;
  const lines = readFileSync(pidFile, "utf8").split("\n");
  const pid = Number(lines[0]);
  assert(Number.isSafeInteger(pid) && pid > 1);
  assert.equal(realpathSync(lines[1]), marker.dataDirectory);
  if (!processAlive(pid)) return null;
  // A PID file alone is insufficient because a stale PID can belong to another task.
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  assert(command.includes(cluster.dataDirectory) && /(?:^|\/)postgres(?:\s|$)/.test(command), "REHEARSAL process ownership mismatch");
  return pid;
}
function descendantPids(parentPid) {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const rows = output.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const found = new Set([parentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) if (found.has(parent) && !found.has(pid)) { found.add(pid); changed = true; }
  }
  return [...found];
}
async function cleanupCluster() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await Promise.allSettled([...clients].map((client) => client.end()));
    clients.clear();
    if (!cluster) return;
    // Also inspect a partially started cluster after pg_ctl start/initdb failure.
    const pid = existsSync(join(cluster.dataDirectory, "postmaster.pid")) ? ownedPostmaster() : null;
    if (pid) {
      const ownedPids = descendantPids(pid);
      try {
        execFileSync(`${BIN}pg_ctl`, ["-D", cluster.dataDirectory, "-m", "fast", "-w", "-t", "20", "stop"], { stdio: "pipe", timeout: 25_000 });
      } catch {
        // Escalate only after verifying the same task-owned postmaster again.
        if (ownedPostmaster() === pid) execFileSync(`${BIN}pg_ctl`, ["-D", cluster.dataDirectory, "-m", "immediate", "-w", "-t", "10", "stop"], { stdio: "pipe", timeout: 15_000 });
      }
      const deadline = Date.now() + 5_000;
      while (ownedPids.some(processAlive) && Date.now() < deadline) await sleep(50);
      assert(!ownedPids.some(processAlive), "REHEARSAL owned PostgreSQL processes did not exit; directory retained");
    }
    assert(!existsSync(join(cluster.dataDirectory, "postmaster.pid")), "REHEARSAL cluster still reports a postmaster; directory retained");
    rmSync(cluster.directory, { recursive: true, force: false });
    assert(!existsSync(cluster.directory), "REHEARSAL directory cleanup failed");
    console.log("PASS cleanup: exact owned PostgreSQL process tree exited and private cluster directory removed.");
  })();
  return cleanupPromise;
}
async function connect(database = LOCAL_DB, applicationName = "test-workspace-local-rehearsal") {
  ensureActive();
  const client = new pg.Client({ host: "127.0.0.1", port: cluster.port, user: "postgres", password: cluster.password,
    database, ssl: false, application_name: applicationName, connectionTimeoutMillis: 10_000, statement_timeout: 120_000 });
  clients.add(client);
  client.on("error", () => { /* Active query rejects; never log private SQL or connection data. */ });
  await client.connect();
  const { rows } = await client.query("select current_setting('data_directory') as directory, host(inet_server_addr()) as address, inet_server_port() as port");
  assert.equal(realpathSync(rows[0].directory), realpathSync(cluster.dataDirectory));
  assert.equal(rows[0].address, "127.0.0.1");
  assert.equal(rows[0].port, cluster.port);
  return client;
}
async function close(client) { clients.delete(client); await client.end(); }
function sourceLocation(stack) {
  const match = /test-workspace-release-local-rehearsal\.mjs:(\d+):(\d+)/.exec(stack ?? "");
  return match ? `scripts/testing/test-workspace-release-local-rehearsal.mjs:${match[1]}:${match[2]}` : null;
}
async function query(client, text, values) {
  ensureActive();
  const location = sourceLocation(new Error().stack?.split("\n").slice(2).join("\n"));
  try { return await client.query(text, values); }
  catch (error) { error.rehearsalSource = location; throw error; }
}
async function startCluster() {
  for (const binary of ["initdb", "pg_ctl", "pg_dump"]) assert.match(run(`${BIN}${binary}`, ["--version"]), /PostgreSQL\) 17\./);
  const directory = mkdtempSync(join(tmpdir(), "proplane-test-workspace-pg17-"));
  const dataDirectory = join(directory, "data");
  cluster = { directory, dataDirectory, port: null, password: randomBytes(24).toString("hex"), token: randomBytes(16).toString("hex") };
  mkdirSync(dataDirectory, { mode: 0o700 });
  writeFileSync(join(directory, "owner.json"), JSON.stringify({ ownerPid: process.pid, token: cluster.token, dataDirectory: realpathSync(dataDirectory) }), { mode: 0o600, flag: "wx" });
  cluster.port = await availablePort();
  const passwordFile = join(directory, "password");
  writeFileSync(passwordFile, cluster.password + "\n", { mode: 0o600, flag: "wx" });
  run(`${BIN}initdb`, ["-D", dataDirectory, "--username=postgres", "--auth-local=trust", "--auth-host=scram-sha-256", `--pwfile=${passwordFile}`, "--no-locale", "--encoding=UTF8"]);
  rmSync(passwordFile);
  appendFileSync(join(dataDirectory, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${cluster.port}\nunix_socket_directories=''\nshared_buffers='16MB'\nmax_connections=10\nmax_worker_processes=0\nmax_parallel_workers=0\nautovacuum=off\nwork_mem='1MB'\nmaintenance_work_mem='16MB'\nwal_buffers='512kB'\nmin_wal_size='32MB'\nmax_wal_size='64MB'\n`, { mode: 0o600 });
  run(`${BIN}pg_ctl`, ["-D", dataDirectory, "-l", join(directory, "postgres.log"), "-w", "-t", "30", "start"]);
  ownedPostmaster();
  const admin = await connect("postgres");
  try {
    for (const role of ROLE_NAMES) {
      assert(ROLE_NAMES.includes(role));
      await query(admin, `create role ${identifier(role)} nologin ${role === "service_role" ? "bypassrls" : "nobypassrls"} ${role === "supabase_admin" ? "superuser" : "nosuperuser"}`);
    }
    await query(admin, `create database ${identifier(LOCAL_DB)} template template0`);
  } finally { await close(admin); }
}
const AUTH_STUB_SQL = `
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),auth.jwt()->>'sub')::uuid;
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role');
$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role,supabase_admin,supabase_storage_admin;
GRANT SELECT ON auth.users TO supabase_admin,supabase_storage_admin;
`;
async function restore(client, schema, snapshot) {
  await query(client, "drop schema public cascade");
  await query(client, AUTH_STUB_SQL);
  await query(client, stripRestrictionCommands(schema));
  // Restore the dump's session changes to the harness contract, without rewriting its SQL.
  await query(client, "set search_path=pg_catalog,public; set check_function_bodies=on; set row_security=on; set statement_timeout='120s'; set lock_timeout='5s'");
  await query(client, "begin");
  try {
    for (const row of snapshot.ledger) {
      await query(client, "insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3::text[])", [row.version, row.name, row.statements]);
    }
    await query(client, "commit");
  } catch (error) { await client.query("rollback"); throw error; }
  for (const table of snapshot.tables) {
    const { rows } = await query(client, `select count(*)::int as count from public.${identifier(table.name)}`);
    assert.equal(rows[0].count, 0, "REHEARSAL schema restore must contain no customer rows");
  }
}
function schemaDigest() {
  const dump = run(`${BIN}pg_dump`, ["--host", "127.0.0.1", "--port", String(cluster.port), "--username", "postgres", "--dbname", LOCAL_DB, "--schema-only"], {
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C", PGPASSWORD: cluster.password, PGSSLMODE: "disable", PGCONNECT_TIMEOUT: "5" },
  });
  return sha256(stripRestrictionCommands(dump));
}
function ledgerFingerprints(rows) {
  return rows.map((row) => ({ version: row.version, name: row.name, digest: ledgerRowDigest(row) })).sort((a,b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
}
async function assertBaseline(client, snapshot, digest) {
  const { rows } = await query(client, "select version,name,statements from supabase_migrations.schema_migrations order by version");
  assert.deepEqual(ledgerFingerprints(rows), ledgerFingerprints(snapshot.ledger));
  assert.equal(schemaDigest(), digest, "REHEARSAL rollback did not restore complete schema/ACL baseline");
}
async function attest(client, project = TARGETS.staging, backup = LOCAL_BACKUP_SHA) {
  await query(client, "select set_config('proplane.release_project_ref',$1,false),set_config('proplane.release_backup_sha256',$2,false)", [project, backup]);
}
async function expectRefusal(client, sql, expectedMessage) {
  let failure;
  try { await query(client, sql); } catch (error) { failure = error; }
  finally { await client.query("rollback"); }
  assert(failure, "REHEARSAL expected bundle refusal");
  assert.equal(failure.message, expectedMessage);
}
async function fingerprintParity(client) {
  const variants = [null, [], [null], [""], ["quote'", "backslash\\", "dollar$$; COMMIT;", "UTF8 🛩️ 漢字 é", "\r\n\t"], ["a", "bc"], ["ab", "c"]];
  for (const statements of variants) {
    const row = { version: "19000101000000", name: statements === null ? null : "unicode_🛩️", statements };
    const result = await query(client, `with sample(version,name,statements) as (values($1::text,$2::text,$3::text[]))
      select encode(sha256(convert_to('S'||octet_length(version)::text||':'||version||
        case when name is null then 'N' else 'S'||octet_length(name)::text||':'||name end||
        case when statements is null then 'N' else 'A'||cardinality(statements)::text||':'||
        coalesce((select string_agg(case when item is null then 'N' else 'S'||octet_length(item)::text||':'||item end,'' order by ordinal)
          from unnest(statements) with ordinality as items(item,ordinal)),'') end,'UTF8')),'hex') as digest from sample`, [row.version,row.name,row.statements]);
    assert.equal(result.rows[0].digest, ledgerRowDigest(row));
  }
  results.push("JavaScript/PostgreSQL UTF-8/null/array fingerprint equivalence");
}
async function midBundleRollback(client, bundle, snapshot, baselineDigest) {
  const observer = await connect(LOCAL_DB, "test-workspace-rehearsal-observer");
  let running;
  try {
    await query(observer, "select pg_advisory_lock($1::bigint)", [BARRIER]);
    const marker = "-- EXACT 20260918133000_remove_raw_live_listing_read_policy.sql";
    assert.equal(bundle.sql.split(marker).length, 2);
    const injected = bundle.sql.replace(marker, `select pg_advisory_xact_lock(${BARRIER}::bigint);\nDO $local_fault$ BEGIN RAISE EXCEPTION 'REHEARSAL_MID_BUNDLE_FAULT'; END $local_fault$;\n${marker}`);
    running = query(client, injected).then(() => ({ error: null }), (error) => ({ error }));
    const deadline = Date.now() + 20_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const { rows } = await query(observer, "select exists(select 1 from pg_stat_activity where application_name='test-workspace-local-rehearsal' and wait_event_type='Lock' and wait_event='advisory') as waiting");
      if (rows[0].waiting) { waiting = true; break; }
      await sleep(100);
    }
    assert(waiting, "REHEARSAL migration did not reach private advisory barrier");
    const { rows } = await query(observer, "select exists(select 1 from pg_policy where polrelid='public.manager_property_records'::regclass and polname='manager_property_records_select_live') as visible");
    assert.equal(rows[0].visible, false, "REHEARSAL intermediate raw listing policy became visible");
    await query(observer, "select pg_advisory_unlock($1::bigint)", [BARRIER]);
    const outcome = await running;
    assert.equal(outcome.error?.message, "REHEARSAL_MID_BUNDLE_FAULT");
  } finally {
    await observer.query("select pg_advisory_unlock_all()").catch(() => {});
    if (running) await running;
    await client.query("rollback");
    await close(observer);
  }
  await assertBaseline(client, snapshot, baselineDigest);
  results.push("mid-bundle fault rollback and no externally visible intermediate raw listing policy");
}
async function policyProbes(client) {
  const normal = "11111111-1111-4111-8111-111111111111";
  const classified = "22222222-2222-4222-8222-222222222222";
  const workspace = "33333333-3333-4333-8333-333333333333";
  await query(client, "begin");
  try {
    await query(client, "insert into auth.users(id,email,raw_user_meta_data) values ($1,'normal@rehearsal.invalid','{}'),($2,'classified@rehearsal.invalid','{}')", [normal, classified]);
    await query(client, "insert into public.test_workspaces(id,name,created_by_user_id) values($1,'Local rehearsal',$2)", [workspace,normal]);
    await query(client, "insert into public.test_workspace_members(workspace_id,user_id,portal_role,created_by_user_id) values($1,$2,'manager',$3)", [workspace,classified,normal]);
    await query(client, "insert into public.agent_user_preferences(user_id,custom_instructions) values($1,'normal fixture'),($2,'classified fixture')", [normal,classified]);
    // The target's three late tables currently have no permissive policy. Add a
    // transaction-only own-row policy to prove the actual restrictive policy wins.
    await query(client, "create policy local_rehearsal_own_read on public.agent_user_preferences for select to authenticated using(user_id=auth.uid()); grant select on public.agent_user_preferences to authenticated");
    for (const [user, expectedClassified, count] of [[normal,false,1],[classified,true,0]]) {
      await query(client, "select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:user,role:"authenticated" })]);
      await query(client, "set local role authenticated");
      const { rows } = await query(client, "select public.is_classified_test_workspace_principal() as classified,(select count(*)::int from public.agent_user_preferences) as count");
      assert.deepEqual(rows[0], { classified:expectedClassified,count });
      await query(client, "reset role");
    }
    for (const state of ["suspended","expired","workspace_suspended","restored"]) {
      await query(client, "update public.test_workspace_members set state=$1,expires_at=$2 where user_id=$3", [state === "suspended" ? "suspended" : "active",state === "expired" ? "2000-01-01T00:00:00Z" : null,classified]);
      await query(client, "update public.test_workspaces set status=$1 where id=$2", [state === "workspace_suspended" ? "suspended" : "active",workspace]);
      await query(client, "set local role authenticated");
      const { rows } = await query(client, "select public.is_classified_test_workspace_principal() as classified,(select count(*)::int from public.agent_user_preferences) as count,(select count(*)::int from public.test_workspace_members) as memberships");
      assert.deepEqual(rows[0], { classified:true,count:0,memberships:1 });
      await query(client, "reset role");
    }
    await query(client, "set local role service_role");
    const service = await query(client, "select count(*)::int as count from public.agent_user_preferences");
    assert.equal(service.rows[0].count, 2);
    await query(client, "reset role");
    const privileges = await query(client, "select has_function_privilege('anon','public.allocate_sms_proxy_number(uuid)','execute') as anon,has_function_privilege('authenticated','public.allocate_sms_proxy_number(uuid)','execute') as authenticated,has_function_privilege('service_role','public.allocate_sms_proxy_number(uuid)','execute') as service");
    assert.deepEqual(privileges.rows[0], { anon:false,authenticated:false,service:true });
  } finally { await client.query("rollback"); }
  results.push("actual late-table restrictive policy with rollback-only permissive probe, durable classification states, own membership, service bypass and allocator privileges");
}
async function main() {
  assert.equal(process.argv.length, 2, "REHEARSAL takes no paths, targets or connection arguments");
  assert.match(process.versions.node, /^22\./, "REHEARSAL requires the repository's Node 22 runtime");
  assert(process.execArgv.includes("--max-old-space-size=256") && getHeapStatistics().heap_size_limit <= 320 * 1024 * 1024,
    "REHEARSAL requires --max-old-space-size=256");
  const schema = readFileSync(join(BACKUP_DIR, "schema-with-acl.sql"));
  const capture = readFileSync(join(BACKUP_DIR, "full-catalog.json"));
  assert.equal(sha256(schema), SCHEMA_SHA, "REHEARSAL pinned actual schema changed");
  assert.equal(sha256(capture), CAPTURE_SHA, "REHEARSAL pinned actual ledger capture changed");
  const rawSnapshot = JSON.parse(capture.toString("utf8"));
  const snapshot = validateSnapshot(rawSnapshot, "staging");
  const bundle = buildAtomicBundle({ target:"staging",snapshot:rawSnapshot,backupSha256:LOCAL_BACKUP_SHA });
  phase = "cluster-start";
  await startCluster();
  const client = await connect();
  try {
    phase = "actual-schema-restore";
    await restore(client, schema.toString("utf8"), snapshot);
    const baselineDigest = schemaDigest();
    await assertBaseline(client,snapshot,baselineDigest);
    results.push("actual pinned staging schema/ACL restored; exact historical ledger inserted as data; no customer rows");
    phase = "fingerprint-parity";
    await fingerprintParity(client);
    phase = "attestation-refusals";
    for (const [project,backup] of [["",""],[TARGETS.production,LOCAL_BACKUP_SHA],[TARGETS.staging,"0".repeat(64)]]) {
      await attest(client,project,backup);
      await expectRefusal(client,bundle.sql,"Root target/backup attestation missing or wrong");
      await assertBaseline(client,snapshot,baselineDigest);
    }
    results.push("missing/wrong target and backup refused before DDL");
    await attest(client);
    phase = "ledger-drift-refusal";
    const row = snapshot.ledger[0];
    try {
      await query(client,"update supabase_migrations.schema_migrations set statements=$1::text[] where version=$2",[[...(row.statements ?? []),"-- local rehearsal drift"],row.version]);
      await expectRefusal(client,bundle.sql,"Exact historical migration ledger changed");
    } finally {
      await query(client,"update supabase_migrations.schema_migrations set statements=$1::text[] where version=$2",[row.statements,row.version]);
    }
    await assertBaseline(client,snapshot,baselineDigest);
    results.push("same-name historical statement drift refused without schema or ledger additions");
    phase = "mid-bundle-rollback";
    await midBundleRollback(client,bundle,snapshot,baselineDigest);
    phase = "exact-bundle-success";
    await query(client,bundle.sql);
    const installed = await query(client,"select version,name,statements from supabase_migrations.schema_migrations order by version");
    assert.deepEqual(ledgerFingerprints(installed.rows),ledgerFingerprints([...snapshot.ledger,...reviewedMigrations()]));
    const installedDigest = schemaDigest();
    results.push("exact unmodified ten-migration bundle committed with all generated postconditions and exact ledger preservation");
    phase = "policy-probes";
    await policyProbes(client);
    assert.equal(schemaDigest(),installedDigest,"REHEARSAL probe schema changes did not roll back");
    console.log(JSON.stringify({ status:"passed",target:"local-disposable-postgresql-17",sourceProject:TARGETS.staging,bundleSha256:bundle.plan.bundleSha256,results,
      limits:["Synthetic auth functions and empty business data; no real sessions, Storage HTTP, providers, app browser or cloud transport were exercised.","The generated session attestations are local test values, not production backup/identity evidence."] },null,2));
  } finally { await close(client); }
}
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  for (const client of clients) void client.end().catch(() => {});
});
try { await main(); }
catch (error) {
  // PostgreSQL detail/context can include historical SQL. Emit only bounded diagnostics.
  console.error(JSON.stringify({ status:"failed",phase,errorCode:typeof error?.code === "string" ? error.code : "ASSERTION_OR_RUNTIME",position:error?.position ?? null,source:error?.rehearsalSource ?? sourceLocation(error?.stack) }));
  process.exitCode = 1;
} finally {
  try { await cleanupCluster(); }
  catch { console.error(JSON.stringify({ status:"cleanup_failed",directory:cluster?.directory ?? null,message:"Owned cluster shutdown/removal could not be verified; no unrelated process was stopped." })); process.exitCode = 1; }
}
