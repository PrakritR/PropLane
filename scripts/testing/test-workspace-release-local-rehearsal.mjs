#!/usr/bin/env node
/** Actual pinned staging/production schema, synthetic auth, no customer rows, no cloud connection path. */
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
import { BASELINE_CATALOG_SQL, baselineMigrations, buildBaselineBundle, INVITATION_DIGEST_SQL } from "../prepare-test-workspace-baseline-prerequisites.mjs";
import { COMPACT_STATEMENTS_SHA_SQL, REMINDER_ATTESTATION } from "../historical-migration-parity-attestation.mjs";

const DEFAULT_TARGET = "staging";
const REHEARSAL_TARGETS = Object.freeze({
  staging: Object.freeze({
    project: TARGETS.staging,
    backupDirectory: "/Users/akhilvemuri/.local/state/proplane-release-backups/20260919-staging-test-workspace",
    schemaSha256: "5ef79f5aec15630bc1fa8ee032902a7e70fde7d7dd267bb1d1e7cce85621da3d",
    catalogSha256: "e5e5e21ecb5fc317f551b23108258e48b36d9c09b2a75654162a7852f1abcabd",
    baselineCatalogSha256: "538d4c6f14f957967b74f5057f20a0d4fa80fb0b6388e00a5c715e52df4c604a",
    invitationRowsSha256: "f5d2d1478f917c60a9cd5f874f8f43b4975e2ad337f5370e5c1112d55b3039fc",
  }),
  production: Object.freeze({
    project: TARGETS.production,
    backupDirectory: "/Users/akhilvemuri/.local/state/proplane-release-backups/20260919-production-test-workspace",
    schemaSha256: "122bfcf96f0e093fc450893c04436be94f95d6a65475f479ec2ebdb1d58b0f7f",
    catalogSha256: "a7a32a72e2cfef3c9df79356ef56f3e0f8a691e6e33b269a4388b0b86513f88f",
    baselineCatalogSha256: "17ed6e241f9417ff717a8f37832eef4741f288e0247da5c1ebab9c35d5e5e83a",
    invitationRowsSha256: "64d30833f4cb607499e29a1d55a167a38e4ceb8b61a1a0b82ece1af8940cf1a2",
  }),
});
const REMINDER_REHEARSAL_ATTESTATION = Object.freeze({
  staging: Object.freeze({
    name: REMINDER_ATTESTATION.name,
    statements: Object.freeze({
      "20260916051253": REMINDER_ATTESTATION.statements["20260916063005"],
    }),
  }),
  production: Object.freeze({
    name: REMINDER_ATTESTATION.name,
    statements: REMINDER_ATTESTATION.statements,
  }),
});
const BIN = "/opt/homebrew/bin/";
const ROLE_NAMES = Object.freeze(["anon", "authenticated", "service_role", "dashboard_user", "supabase_admin", "supabase_storage_admin"]);
const LOCAL_DB = "test_workspace_rehearsal";
const BARRIER = "20260919124501";
let phase = "input";
let interrupted = false;
let cluster;
let cleanupPromise;
const clients = new Set();
const results = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function rehearsalTarget(argv) {
  if (argv.length === 0) return DEFAULT_TARGET;
  assert.deepEqual(argv.slice(0, 1), ["--target"], "REHEARSAL accepts only --target staging|production");
  assert.equal(argv.length, 2, "REHEARSAL accepts only --target staging|production");
  assert(Object.hasOwn(REHEARSAL_TARGETS, argv[1]), "REHEARSAL target must be staging or production");
  return argv[1];
}
function localBackupSha256(target, backup) {
  return sha256(JSON.stringify({
    purpose: "local-only-rehearsal",
    target,
    schema: backup.schemaSha256,
    catalog: backup.catalogSha256,
    baselineCatalog: backup.baselineCatalogSha256,
  }));
}
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
function sameSnapshotState(left, right) {
  assert.deepEqual(ledgerFingerprints(left.ledger), ledgerFingerprints(right.ledger), "REHEARSAL full and baseline catalogs disagree on historical ledger");
  assert.deepEqual(left.tables, right.tables, "REHEARSAL full and baseline catalogs disagree on public table inventory");
}
function withReviewedInvitationRowsSha256(snapshot, expected) {
  assert.match(expected, /^[a-f0-9]{64}$/, "REHEARSAL pinned invitationRowsSha256 must be a SHA-256");
  if (Object.hasOwn(snapshot, "invitationRowsSha256")) {
    assert.equal(snapshot.invitationRowsSha256, expected, "REHEARSAL captured invitationRowsSha256 differs from the pinned target value");
  }
  return { ...snapshot, invitationRowsSha256: expected };
}
async function captureLocalSnapshot(client, target) {
  const ledger = await query(client, "select version,name,statements from supabase_migrations.schema_migrations order by version");
  const tables = await query(client, `select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') order by c.relname collate \"C\"`);
  const validated = validateSnapshot(
    { project: TARGETS[target], read_only: "on", ledger: ledger.rows, tables: tables.rows },
    target,
  );
  // validateSnapshot deliberately returns normalized catalog fields only. The
  // bundle preparer independently requires the read-only capture attestation.
  return { ...validated, read_only: "on" };
}
async function captureLocalBaselineSnapshot(client, target, capturedSnapshot, invitationRowsSha256) {
  const snapshot = await captureLocalSnapshot(client, target);
  const catalog = await query(client, `select ${BASELINE_CATALOG_SQL} as baseline_catalog`);
  assert.deepEqual(catalog.rows[0].baseline_catalog, capturedSnapshot.baselineCatalog, "REHEARSAL restored catalog differs from the captured reviewed baseline catalog");
  return { ...snapshot, baselineCatalog: catalog.rows[0].baseline_catalog, invitationRowsSha256 };
}
async function invitationRowsSha256(client) {
  const { rows } = await query(client, `select ${INVITATION_DIGEST_SQL} as digest`);
  return rows[0].digest;
}
function localBaselineBundle({ target, snapshot, backupSha256, invitationRowsSha256 }) {
  return buildBaselineBundle({
    target,
    snapshot: { ...snapshot, invitationRowsSha256 },
    backupSha256,
  });
}
async function seedBaselineInvitation(client, workspacePermissions) {
  const inviter = "55555555-5555-4555-8555-555555555555";
  const invitee = "66666666-6666-4666-8666-666666666666";
  const invite = "77777777-7777-4777-8777-777777777777";
  await query(client, "insert into auth.users(id,email,raw_user_meta_data) values ($1,'baseline-inviter@rehearsal.invalid','{}'),($2,'baseline-invitee@rehearsal.invalid','{}')", [inviter, invitee]);
  await query(client, `insert into public.account_link_invites(id,inviter_user_id,invitee_user_id,tab_kind,inviter_axis_id,invitee_axis_id,status,workspace_permissions)
    values($1,$2,$3,'manager','AXIS-BASELINE-INVITER','AXIS-BASELINE-INVITEE','accepted',$4::jsonb)`, [invite, inviter, invitee, JSON.stringify(workspacePermissions)]);
  return { inviter, invitee, invite };
}
async function removeBaselineInvitation(client, fixture) {
  await query(client, "select set_config('proplane.account_recovery_internal','on',false)");
  try {
    await query(client, "delete from public.account_link_invites where id=$1", [fixture.invite]);
    await query(client, "delete from auth.users where id=any($1::uuid[])", [[fixture.inviter, fixture.invitee]]);
  } finally {
    await query(client, "select set_config('proplane.account_recovery_internal','off',false)");
  }
}
async function assertHistoricalStatementArrayParity(client, target, checks) {
  const attestation = REMINDER_REHEARSAL_ATTESTATION[target];
  for (const { label, rows } of checks) {
    const attestedRows = rows.filter((row) => row.name === attestation.name
      && Object.hasOwn(attestation.statements, row.version));
    assert.equal(attestedRows.length, Object.keys(attestation.statements).length,
      `REHEARSAL missing target historical reminder rows: ${label}`);
    const expected = attestedRows
      .map((row) => {
        const digest = sha256(JSON.stringify(row.statements));
        assert.equal(digest, attestation.statements[row.version], `REHEARSAL unexpected historical reminder statement array: ${label}`);
        return { version: row.version, compact_sha256: digest, array_json_sha256: digest };
      })
      .sort((left, right) => left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
    const versions = attestedRows.map((row) => row.version);
    const result = await query(client, `select version,${COMPACT_STATEMENTS_SHA_SQL} as compact_sha256,
      encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') as array_json_sha256
      from supabase_migrations.schema_migrations where name=$1 and version=any($2::text[]) order by version collate "C"`, [attestation.name, versions]);
    assert.deepEqual(result.rows, expected, `REHEARSAL exact historical statement arrays changed: ${label}`);
    results.push(`${label} JavaScript/PostgreSQL COMPACT_STATEMENTS_SHA_SQL and array_to_json statement-array SHA-256 parity`);
  }
}
async function attest(client, project, backup) {
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
async function baselineRefusals(client, capturedSnapshot, snapshot, baselineDigest, target, project, backupSha256) {
  const localSnapshot = await captureLocalBaselineSnapshot(client, target, capturedSnapshot, await invitationRowsSha256(client));
  const recoveryBundle = localBaselineBundle({ target, snapshot: localSnapshot, backupSha256, invitationRowsSha256: localSnapshot.invitationRowsSha256 });
  await attest(client, project, backupSha256);
  await query(client, "select set_config('proplane.account_recovery_internal','on',false)");
  try {
    await expectRefusal(client, recoveryBundle.sql, "Encoding or recovery bypass rejected");
  } finally {
    await query(client, "select set_config('proplane.account_recovery_internal','off',false)");
  }
  await assertBaseline(client, snapshot, baselineDigest);

  await query(client, "set session_replication_role=replica");
  try {
    await attest(client, project, backupSha256);
    await expectRefusal(client, recoveryBundle.sql, "Origin replication mode required");
  } finally {
    await query(client, "set session_replication_role=origin");
  }
  await assertBaseline(client, snapshot, baselineDigest);

  const fixture = await seedBaselineInvitation(client, {});
  try {
    const localInvitationRowsSha256 = await invitationRowsSha256(client);
    const fixtureSnapshot = await captureLocalBaselineSnapshot(client, target, capturedSnapshot, localInvitationRowsSha256);
    const wrongPreimageBundle = localBaselineBundle({ target, snapshot: fixtureSnapshot, backupSha256, invitationRowsSha256: "0".repeat(64) });
    await attest(client, project, backupSha256);
    await expectRefusal(client, wrongPreimageBundle.sql, "Reviewed invitation beforeimage changed");
    const grantExpansionBundle = localBaselineBundle({ target, snapshot: fixtureSnapshot, backupSha256, invitationRowsSha256: localInvitationRowsSha256 });
    await attest(client, project, backupSha256);
    await expectRefusal(client, grantExpansionBundle.sql, "Permission change prohibited");
  } finally {
    await removeBaselineInvitation(client, fixture);
  }
  await assertBaseline(client, snapshot, baselineDigest);
  results.push("baseline recovery-bypass, replica-mode, invitation preimage, and grant-expansion refusals preserve schema and history");
}
async function applyBaselineBundle(client, capturedSnapshot, snapshot, target, project, backupSha256) {
  const fixture = await seedBaselineInvitation(client, { addProperties: true });
  try {
    const invitationBefore = await invitationRowsSha256(client);
    const localSnapshot = await captureLocalBaselineSnapshot(client, target, capturedSnapshot, invitationBefore);
    const bundle = localBaselineBundle({ target, snapshot: localSnapshot, backupSha256, invitationRowsSha256: invitationBefore });
    await attest(client, project, backupSha256);
    await query(client, bundle.sql);
    const invitationAfter = await invitationRowsSha256(client);
    assert.equal(invitationAfter, invitationBefore, "REHEARSAL baseline bundle changed an unchanged invitation row");
    const installed = await query(client, "select version,name,statements from supabase_migrations.schema_migrations order by version");
    assert.deepEqual(
      ledgerFingerprints(installed.rows),
      ledgerFingerprints([...snapshot.ledger, ...baselineMigrations(target)]),
      "REHEARSAL baseline bundle changed historical ledger rows or appended the wrong entries",
    );
  } finally {
    await removeBaselineInvitation(client, fixture);
  }
  results.push("reviewed baseline bundle committed first with unchanged invitation row and exact historical ledger preservation");
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
  const target = rehearsalTarget(process.argv.slice(2));
  const backup = REHEARSAL_TARGETS[target];
  const localAttestationSha256 = localBackupSha256(target, backup);
  assert.match(process.versions.node, /^22\./, "REHEARSAL requires the repository's Node 22 runtime");
  assert(process.execArgv.includes("--max-old-space-size=256") && getHeapStatistics().heap_size_limit <= 320 * 1024 * 1024,
    "REHEARSAL requires --max-old-space-size=256");
  const schema = readFileSync(join(backup.backupDirectory, "schema-with-acl.sql"));
  const capture = readFileSync(join(backup.backupDirectory, "full-catalog.json"));
  const baselineCapture = readFileSync(join(backup.backupDirectory, "full-catalog-baseline.json"));
  assert.equal(sha256(schema), backup.schemaSha256, "REHEARSAL pinned actual schema changed");
  assert.equal(sha256(capture), backup.catalogSha256, "REHEARSAL pinned actual ledger capture changed");
  assert.equal(sha256(baselineCapture), backup.baselineCatalogSha256, "REHEARSAL pinned actual baseline catalog changed");
  const rawSnapshot = JSON.parse(capture.toString("utf8"));
  const rawBaselineSnapshot = JSON.parse(baselineCapture.toString("utf8"));
  const snapshot = validateSnapshot(rawSnapshot, target);
  const baselineSnapshot = validateSnapshot(rawBaselineSnapshot, target);
  sameSnapshotState(snapshot, baselineSnapshot);
  const preparedSnapshot = withReviewedInvitationRowsSha256(rawSnapshot, backup.invitationRowsSha256);
  const preparedBaselineSnapshot = withReviewedInvitationRowsSha256(rawBaselineSnapshot, backup.invitationRowsSha256);
  assert.equal(preparedSnapshot.invitationRowsSha256, preparedBaselineSnapshot.invitationRowsSha256, "REHEARSAL full and baseline captures disagree on invitationRowsSha256");
  phase = "cluster-start";
  await startCluster();
  const client = await connect();
  try {
    phase = "actual-schema-restore";
    await restore(client, schema.toString("utf8"), baselineSnapshot);
    const baselineDigest = schemaDigest();
    await assertBaseline(client, baselineSnapshot, baselineDigest);
    results.push(`actual pinned ${target} schema/ACL restored; exact historical ledger inserted as data; no customer rows`);
    phase = "baseline-refusals";
    await baselineRefusals(client, preparedBaselineSnapshot, baselineSnapshot, baselineDigest, target, backup.project, localAttestationSha256);
    phase = "baseline-bundle-success";
    await applyBaselineBundle(client, preparedBaselineSnapshot, baselineSnapshot, target, backup.project, localAttestationSha256);
    const featureSnapshot = await captureLocalSnapshot(client, target);
    const featureBaselineDigest = schemaDigest();
    const bundle = buildAtomicBundle({ target, snapshot: featureSnapshot, backupSha256: localAttestationSha256 });
    results.push(`fresh local ledger/table catalog captured after the ${baselineMigrations(target).length}-file baseline before immutable feature bundle generation`);
    phase = "fingerprint-parity";
    await fingerprintParity(client);
    phase = "attestation-refusals";
    const wrongProject = target === "staging" ? TARGETS.production : TARGETS.staging;
    for (const [project,attestedBackup] of [["",""],[wrongProject,localAttestationSha256],[backup.project,"0".repeat(64)]]) {
      await attest(client,project,attestedBackup);
      await expectRefusal(client,bundle.sql,"Root target/backup attestation missing or wrong");
      await assertBaseline(client,featureSnapshot,featureBaselineDigest);
    }
    results.push("missing/wrong target and backup refused before DDL");
    await attest(client,backup.project,localAttestationSha256);
    phase = "ledger-drift-refusal";
    const row = featureSnapshot.ledger[0];
    try {
      await query(client,"update supabase_migrations.schema_migrations set statements=$1::text[] where version=$2",[[...(row.statements ?? []),"-- local rehearsal drift"],row.version]);
      await expectRefusal(client,bundle.sql,"Exact historical migration ledger changed");
    } finally {
      await query(client,"update supabase_migrations.schema_migrations set statements=$1::text[] where version=$2",[row.statements,row.version]);
    }
    await assertBaseline(client,featureSnapshot,featureBaselineDigest);
    results.push("same-name historical statement drift refused without schema or ledger additions");
    phase = "mid-bundle-rollback";
    await midBundleRollback(client,bundle,featureSnapshot,featureBaselineDigest);
    phase = "exact-bundle-success";
    await query(client,bundle.sql);
    const installed = await query(client,"select version,name,statements from supabase_migrations.schema_migrations order by version");
    assert.deepEqual(ledgerFingerprints(installed.rows),ledgerFingerprints([...featureSnapshot.ledger,...reviewedMigrations()]));
    const installedDigest = schemaDigest();
    results.push("exact unmodified ten-migration bundle committed with all generated postconditions and exact ledger preservation");
    phase = "policy-probes";
    await policyProbes(client);
    assert.equal(schemaDigest(),installedDigest,"REHEARSAL probe schema changes did not roll back");
    phase = "compact-historical-json-parity";
    await assertHistoricalStatementArrayParity(client, target, [
      { label: "pre-baseline historical ledger", rows: baselineSnapshot.ledger },
      { label: "pre-feature historical ledger", rows: featureSnapshot.ledger },
    ]);
    console.log(JSON.stringify({ status:"passed",target:"local-disposable-postgresql-17",sourceProject:backup.project,bundleSha256:bundle.plan.bundleSha256,results,
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
