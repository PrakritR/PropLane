#!/usr/bin/env node
/** Rehearse the reviewed bundle against a private, disposable PostgreSQL cluster. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import pg from "pg";
import { generatePrivateWorkspace, reviewedMigrationManifest } from "../prepare-20260911-production-migrations.mjs";

const ROOT = process.cwd();
const FIXTURE = join(ROOT, "scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql");
const workspace = mkdtempSync("/tmp/proplane-migration-rehearsal-");
const dataDir = join(workspace, "postgres");
const socketDir = join(workspace, "socket");
let clusterStarted = false;
const SENTINEL_FAILURE = "ERROR: Historical ledger sentinel must never execute (SQLSTATE P0001)";
const CONTENTION_FAILURE = "ERROR: production recovery rollout is already locked (SQLSTATE P0001)";
const DIVISION_FAILURE = "ERROR: division by zero (SQLSTATE 22012)";
const BUCKET_FAILURE = "ERROR: production recovery bucket is no longer absent (SQLSTATE P0001)";
const POST_SOURCE_BUCKET_FAILURE = "ERROR: production recovery bucket is not private after install (SQLSTATE P0001)";

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe", ...options });
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ROOT, encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve(stdout);
    });
  });
}

function reportedCliError(output) {
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line)?.error?.message;
      if (typeof message === "string") return message.split("\n", 1)[0];
    } catch {
      // Human-readable CLI progress is not the structured SQL error verdict.
    }
  }
  return "";
}

function runCliExpectFailure(args, expectedDiagnostic) {
  try {
    run("npx", args);
    assert.fail("pinned Supabase CLI unexpectedly succeeded");
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    assert.notEqual(error?.status, 0, "pinned Supabase CLI did not report a failure");
    assert.equal(reportedCliError(output), expectedDiagnostic,
      `pinned Supabase CLI failed for an unrelated reason; expected ${expectedDiagnostic}`);
  }
}

async function runCliExpectFailureAsync(args, expectedDiagnostic) {
  try {
    await runAsync("npx", args);
    assert.fail("pinned Supabase CLI unexpectedly succeeded");
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    assert.notEqual(error?.code, 0, "pinned Supabase CLI did not report a failure");
    assert.equal(reportedCliError(output), expectedDiagnostic,
      `pinned Supabase CLI failed for an unrelated reason; expected ${expectedDiagnostic}`);
  }
}

const sourceOnlyEcho = JSON.stringify({ error: { message: `ERROR: unrelated failure (SQLSTATE XX000)
source: raise exception 'Historical ledger sentinel must never execute';
raise exception 'production recovery rollout is already locked';
select 1/0; -- division by zero
raise exception 'production recovery bucket is no longer absent';` } });
for (const expected of [
  SENTINEL_FAILURE, CONTENTION_FAILURE, DIVISION_FAILURE, BUCKET_FAILURE, POST_SOURCE_BUCKET_FAILURE,
]) {
  assert.notEqual(reportedCliError(sourceOnlyEcho), expected,
    "a diagnostic matcher must not accept expected text merely echoed in migration source");
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function expectDenied(client, role, sql) {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await assert.rejects(client.query(sql), (error) => error.code === "42501");
  } finally {
    await client.query("rollback");
  }
}

async function waitForAdvisoryWait(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await client.query(`
      select count(*)::integer as count from pg_stat_activity
      where pid <> pg_backend_pid() and wait_event_type = 'Lock' and wait_event = 'advisory'
    `);
    if (rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("concurrent bucket rehearsal did not reach the post-preflight advisory barrier");
}

const port = await availablePort();
const dbUrl = `postgresql://127.0.0.1:${port}/postgres?user=${encodeURIComponent(process.env.USER ?? "postgres")}&sslmode=disable`;

try {
  run("mkdir", ["-p", socketDir]);
  run("initdb", ["-D", dataDir, "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    join(workspace, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${socketDir}`,
    "-w",
    "start",
  ]);
  clusterStarted = true;

  run("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", FIXTURE]);

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const manifest = reviewedMigrationManifest();
    const cliArgs = (workspacePath) => [
      "-y", "supabase@2.117.0", "db", "push", "--db-url", dbUrl,
      "--include-all", "--skip-vault", "--workdir", workspacePath,
    ];
    const sourceTables = [...new Set(manifest.flatMap(({ sql }) =>
      [...sql.matchAll(/create table(?: if not exists)? public\.([a-z0-9_]+)/gi)].map((match) => match[1])))];
    const sourceFunctions = [...new Set(manifest.flatMap(({ sql }) =>
      [...sql.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)/gi)].map((match) => match[1])))];
    const sourceTriggers = [...new Set(manifest.flatMap(({ sql }) =>
      [...sql.matchAll(/create trigger ([a-z0-9_]+)/gi)].map((match) => match[1])))];

    async function assertCleanRollback() {
      const { rows: rolledBack } = await client.query(`
        select count(*) filter (where version = any($1::text[]) or name = any($2::text[]))::integer as ledger_rows,
               count(*) filter (where version = $3 or name = 'production_recovery_schema')::integer as bundle_rows
        from supabase_migrations.schema_migrations
      `, [manifest.map(({ version }) => version), manifest.map(({ name }) => name), "20260911010000"]);
      assert.deepEqual(rolledBack[0], { ledger_rows: 0, bundle_rows: 0 });
      const { rows: sourceObjects } = await client.query(`
        select
          (select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = any($1::text[])) as tables,
          (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any($2::text[])) as functions,
          (select count(*)::integer from pg_trigger
            where not tgisinternal and tgname = any($3::text[])) as triggers
      `, [sourceTables, sourceFunctions, sourceTriggers]);
      assert.deepEqual(sourceObjects[0], { tables: 0, functions: 0, triggers: 0 });
    }

    const missingSentinelWorkspace = generatePrivateWorkspace([
      { version: "20260907090000", name: "resident_invite_links" },
    ]);
    runCliExpectFailure(cliArgs(missingSentinelWorkspace.workspace), SENTINEL_FAILURE);
    await assertCleanRollback();

    const contendedWorkspace = generatePrivateWorkspace([]);
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(723081447302::bigint)");
    const contentionStartedAt = Date.now();
    runCliExpectFailure(cliArgs(contendedWorkspace.workspace), CONTENTION_FAILURE);
    assert(Date.now() - contentionStartedAt < 10_000, "rollout advisory contention did not fail promptly");
    await client.query("rollback");
    await assertCleanRollback();

    async function rehearseInjectedFailure(marker, { append = false } = {}) {
      const failingWorkspace = generatePrivateWorkspace([]);
      const failingBundlePath = join(
        failingWorkspace.workspace,
        "supabase",
        "migrations",
        failingWorkspace.bundleFile,
      );
      const original = readFileSync(failingBundlePath, "utf8");
      if (!append) assert(original.includes(marker));
      const injected = append ? `${original}\nselect 1/0;\n` : original.replace(marker, `select 1/0;\n${marker}`);
      writeFileSync(failingBundlePath, injected, { mode: 0o600 });
      runCliExpectFailure(cliArgs(failingWorkspace.workspace), DIVISION_FAILURE);
      await assertCleanRollback();
    }

    await rehearseInjectedFailure("-- exact source: 20260907225000_account_recovery_identity_patches.sql");
    await rehearseInjectedFailure("insert into supabase_migrations.schema_migrations(version,name,statements) values (");
    await rehearseInjectedFailure("", { append: true });

    for (const isPublic of [true, false]) {
      const bucket = { id: "account-recovery", name: "account-recovery", public: isPublic };
      await client.query("insert into storage.buckets(id,name,public) values ($1,$2,$3)",
        [bucket.id, bucket.name, bucket.public]);
      const bucketWorkspace = generatePrivateWorkspace([]);
      runCliExpectFailure(cliArgs(bucketWorkspace.workspace), BUCKET_FAILURE);
      const { rows: preservedBucket } = await client.query(
        "select id,name,public from storage.buckets where id = $1", [bucket.id]);
      assert.deepEqual(preservedBucket, [bucket]);
      await assertCleanRollback();
      await client.query("delete from storage.buckets where id = $1", [bucket.id]);
    }

    const concurrentWorkspace = generatePrivateWorkspace([]);
    const concurrentBundlePath = join(
      concurrentWorkspace.workspace,
      "supabase",
      "migrations",
      concurrentWorkspace.bundleFile,
    );
    const concurrentMarker = "-- exact source: 20260907230000_account_recovery_object_generations.sql";
    const concurrentBundle = readFileSync(concurrentBundlePath, "utf8");
    assert(concurrentBundle.includes(concurrentMarker));
    writeFileSync(concurrentBundlePath, concurrentBundle.replace(
      concurrentMarker,
      `select pg_advisory_xact_lock(723081447303::bigint);\n${concurrentMarker}`,
    ), { mode: 0o600 });
    const concurrentBucket = {
      id: "account-recovery",
      name: "concurrent-public-fixture",
      public: true,
    };
    await client.query("select pg_advisory_lock(723081447303::bigint)");
    let barrierReleased = false;
    try {
      const concurrentFailure = runCliExpectFailureAsync(
        cliArgs(concurrentWorkspace.workspace),
        POST_SOURCE_BUCKET_FAILURE,
      );
      await waitForAdvisoryWait(client);
      await client.query("insert into storage.buckets(id,name,public) values ($1,$2,$3)", [
        concurrentBucket.id, concurrentBucket.name, concurrentBucket.public,
      ]);
      await client.query("select pg_advisory_unlock(723081447303::bigint)");
      barrierReleased = true;
      await concurrentFailure;
    } finally {
      if (!barrierReleased) await client.query("select pg_advisory_unlock(723081447303::bigint)");
    }
    const { rows: preservedConcurrentBucket } = await client.query(
      "select id,name,public from storage.buckets where id = $1", [concurrentBucket.id]);
    assert.deepEqual(preservedConcurrentBucket, [concurrentBucket]);
    await assertCleanRollback();
    await client.query("delete from storage.buckets where id = $1", [concurrentBucket.id]);

    const exactWorkspace = generatePrivateWorkspace([]);
    run("npx", [
      "-y", "supabase@2.117.0", "db", "push", "--db-url", dbUrl,
      "--include-all", "--skip-vault", "--workdir", exactWorkspace.workspace,
    ]);

    const { rows: ledgerRows } = await client.query(`
      select version, name, statements from supabase_migrations.schema_migrations order by version
    `);
    assert.deepEqual(
      ledgerRows.slice(0, manifest.length).map(({ version, name }) => ({ version, name })),
      manifest.map(({ version, name }) => ({ version, name })),
    );
    for (let index = 0; index < manifest.length; index += 1) {
      assert.deepEqual(ledgerRows[index].statements, [manifest[index].sql]);
    }
    assert.equal(ledgerRows.at(-1)?.name, "production_recovery_schema");

    const { rows: installed } = await client.query(`
      select
        to_regclass('public.webhook_subscriptions') is not null as webhook,
        to_regclass('public.account_recovery_requests') is not null as recovery,
        to_regclass('public.account_deleted_identity_keys') is not null as identity_keys,
        to_regprocedure('public.account_recovery_recover(uuid,uuid,text)') is not null as recover_function,
        to_regprocedure('public.account_recovery_compact_terminal()') is not null as compact_function
    `);
    assert.deepEqual(installed[0], {
      webhook: true,
      recovery: true,
      identity_keys: true,
      recover_function: true,
      compact_function: true,
    });
    const { rows: recoveryBucket } = await client.query(
      "select public from storage.buckets where id = 'account-recovery'");
    assert.deepEqual(recoveryBucket, [{ public: false }]);

    const { rows: policyRows } = await client.query(`
      select relrowsecurity from pg_class
      where oid = 'public.account_recovery_requests'::regclass
    `);
    assert.equal(policyRows[0]?.relrowsecurity, true);
    await client.query("set role service_role");
    await client.query("select count(*) from public.account_recovery_requests");
    await client.query("reset role");
    await expectDenied(client, "anon", "select * from public.account_recovery_requests");
    await expectDenied(client, "authenticated", "select * from public.account_recovery_requests");

    const { rows: triggerRows } = await client.query(`
      select count(*)::integer as count from pg_trigger
      where not tgisinternal and tgname in (
        'account_recovery_write_guard',
        'account_recovery_capture_delete',
        'account_recovery_auth_identity_guard',
        'account_recovery_storage_guard'
      )
    `);
    assert(triggerRows[0].count >= 4);

    await client.query("insert into public.ordinary_fixture(note) values ('ordinary public write')");
    await client.query("insert into auth.users(email) values ('fixture@example.test')");
    await client.query("insert into storage.objects(bucket_id,name) values ('fixture','ordinary/path')");

  } finally {
    await client.end();
  }

  console.log("PASS: pinned CLI exact install, fail-loud sentinel, timeout/contention, existing and concurrent bucket refusal, writes, and three rollback points.");
  console.log(`Ephemeral evidence directory: ${workspace}`);
} finally {
  if (clusterStarted) {
    try {
      run("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
      rmSync(dataDir, { recursive: true });
      rmSync(socketDir, { recursive: true });
    } catch (error) {
      console.error("Task-owned PostgreSQL cluster did not stop cleanly.");
      throw error;
    }
  }
}
