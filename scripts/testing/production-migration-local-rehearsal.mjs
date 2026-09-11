#!/usr/bin/env node
/** Exercise the verified transport against a private, disposable TLS PostgreSQL cluster. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import pg from "pg";
import {
  buildAtomicBundle,
  executeApprovedProductionApply,
  expectedRecoveryCatalog,
  reviewedMigrationManifest,
} from "../prepare-20260911-production-migrations.mjs";

const ROOT = process.cwd();
const FIXTURE = join(ROOT, "scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql");
const OWNER = process.env.USER ?? "postgres";
const PROVIDER_HOST = "aws-0-us-west-2.pooler.supabase.com";
const PROVIDER_USER = "cli_login_postgres.qahnczmilgptcedaqype";
const HISTORICAL = { version: "20260901000000", name: "rehearsal_historical", statements: ["historical fixture bytes"] };
const BUNDLE_VERSION = "20260911010000";
const BUNDLE_NAME = "production_recovery_schema";
const manifest = reviewedMigrationManifest();
const bundle = buildAtomicBundle(manifest);
const catalog = expectedRecoveryCatalog(manifest);

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe", ...options });
}

function quoteIdentifier(value) { return `"${value.replaceAll('"', '""')}"`; }

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function createLocalCertificate(directory) {
  const key = join(directory, "server.key");
  const certificate = join(directory, "server.crt");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", certificate, "-subj", `/CN=${PROVIDER_HOST}`,
    "-addext", `subjectAltName=DNS:${PROVIDER_HOST}`]);
  chmodSync(key, 0o600);
  return { key, certificate, ca: readFileSync(certificate, "utf8") };
}

async function startCluster({ historical = false } = {}) {
  const directory = mkdtempSync("/tmp/proplane-verified-transport-");
  const dataDirectory = join(directory, "postgres");
  const socketDirectory = join(directory, "socket");
  const port = await availablePort();
  const tls = createLocalCertificate(directory);
  let started = false;
  try {
    run("mkdir", ["-p", socketDirectory]);
    run("initdb", ["-D", dataDirectory, "--auth=trust", "--no-locale", "--encoding=UTF8"]);
    run("pg_ctl", ["-D", dataDirectory, "-l", join(directory, "postgres.log"), "-o",
      `-h 127.0.0.1 -p ${port} -k ${socketDirectory} -c ssl=on -c ssl_cert_file=${tls.certificate} -c ssl_key_file=${tls.key}`,
      "-w", "start"]);
    started = true;
    const connection = { host: "127.0.0.1", port, user: OWNER, database: "postgres",
      ssl: { ca: tls.ca, rejectUnauthorized: true, servername: PROVIDER_HOST } };
    const admin = new pg.Client(connection);
    await admin.connect();
    try {
      await admin.query(readFileSync(FIXTURE, "utf8"));
      await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname='postgres') then create role postgres superuser; end if; end $$");
      await admin.query(`grant postgres to ${quoteIdentifier(OWNER)}`);
      await admin.query("grant service_role to postgres");
      // Supabase-managed defaults give webhook tables these non-DML grants; the
      // reviewed SQL then revokes all recovery-table grants and webhook DML.
      await admin.query("alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role");
      if (historical) {
        await admin.query("insert into supabase_migrations.schema_migrations(version,name,statements) values ($1,$2,$3)",
          [HISTORICAL.version, HISTORICAL.name, HISTORICAL.statements]);
      }
    } finally { await admin.end(); }
    return { directory, dataDirectory, port, tls, connection };
  } catch (error) {
    if (started) {
      try { run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]); } catch { /* cleanup below */ }
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function stopCluster(cluster) {
  try { run("pg_ctl", ["-D", cluster.dataDirectory, "-m", "fast", "-w", "stop"]); }
  finally { rmSync(cluster.directory, { recursive: true, force: true }); }
}

async function withCluster(options, callback) {
  const cluster = await startCluster(options);
  try { return await callback(cluster); }
  finally { await stopCluster(cluster); }
}

function cliLogin() {
  return `export PGHOST="${PROVIDER_HOST}"\nexport PGPORT="5432"\nexport PGUSER="${PROVIDER_USER}"\nexport PGPASSWORD="local-rehearsal-password"\nexport PGDATABASE="postgres"`;
}

function assertCredentialCommand(args) {
  assert.deepEqual(args, ["db", "dump", "--project-ref", "qahnczmilgptcedaqype",
    "--data-only", "--schema", "public", "--dry-run", "--yes"]);
}

function localDependencies(cluster, { failure = "none", applicationName = "proplane-rehearsal", tls = "verified" } = {}) {
  let auxiliaryInserted = false;
  let asynchronousErrorEmitted = false;
  let clientCount = 0;
  const observedConnections = [];
  return {
    observedConnections,
    runCli(args) {
      assertCredentialCommand(args);
      return { status: 0, signal: null, timedOut: false, output: cliLogin() };
    },
    createClient(connection) {
      const isOriginalClient = clientCount++ === 0;
      observedConnections.push(connection);
      assert.equal(connection.host, PROVIDER_HOST);
      assert.equal(connection.user, PROVIDER_USER);
      assert.equal(connection.port, 5432);
      assert.equal(connection.database, "postgres");
      assert.equal(connection.ssl.rejectUnauthorized, true);
      assert.equal(connection.ssl.servername, PROVIDER_HOST);
      const localSsl = tls === "untrusted"
        ? { ca: "not the local certificate", rejectUnauthorized: true, servername: PROVIDER_HOST }
        : { ca: cluster.tls.ca, rejectUnauthorized: true, servername: tls === "hostname_mismatch" ? "wrong.local.test" : PROVIDER_HOST };
      const client = new pg.Client({ host: "127.0.0.1", port: cluster.port, user: OWNER, database: "postgres",
        application_name: applicationName, ssl: localSsl });
      const originalQuery = client.query.bind(client);
      client.query = async (...queryArgs) => {
        const statement = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (isOriginalClient && failure === "async_error" && !asynchronousErrorEmitted && statement === "BEGIN READ ONLY") {
          asynchronousErrorEmitted = true;
          client.emit("error", new Error("synthetic-private-secret"));
        }
        if (isOriginalClient && failure === "before_bundle" && statement === bundle) throw new Error("synthetic-private-secret");
        if (isOriginalClient && failure === "before_auxiliary" && statement?.startsWith("insert into supabase_migrations.schema_migrations")) {
          throw new Error("synthetic-private-secret");
        }
        if (isOriginalClient && failure === "before_precommit" && auxiliaryInserted && statement?.startsWith("select version, name, statements")) {
          throw new Error("synthetic-private-secret");
        }
        const result = await originalQuery(...queryArgs);
        if (statement?.startsWith("insert into supabase_migrations.schema_migrations")) auxiliaryInserted = true;
        if (isOriginalClient && failure === "lost_commit_response" && statement === "COMMIT") throw new Error("synthetic-private-secret");
        return result;
      };
      return client;
    },
  };
}

async function query(cluster, statement, values) {
  const client = new pg.Client(cluster.connection);
  await client.connect();
  try { return await client.query(statement, values); }
  finally { await client.end(); }
}

async function assertInstalled(cluster, { historical = [] } = {}) {
  const { rows } = await query(cluster, "select version,name,statements from supabase_migrations.schema_migrations order by version,name");
  assert.deepEqual(rows, [
    ...historical,
    ...manifest.map(({ version, name, sql }) => ({ version, name, statements: [sql] })),
    { version: BUNDLE_VERSION, name: BUNDLE_NAME, statements: [bundle] },
  ]);
  const { rows: topology } = await query(cluster, `select
    to_regclass('public.account_deleted_identity_keys') is not null as identity_keys,
    to_regclass('public.account_deleted_storage_keys') is not null as storage_keys,
    count(*) filter (where t.tgrelid='public.account_deleted_identity_keys'::regclass)::int as identity_key_triggers,
    count(*) filter (where t.tgrelid='public.account_deleted_storage_keys'::regclass)::int as storage_key_triggers
    from pg_trigger t where not t.tgisinternal and t.tgname in ('account_recovery_write_guard','account_recovery_capture_delete')`);
  assert.deepEqual(topology[0], { identity_keys: true, storage_keys: true, identity_key_triggers: 0, storage_key_triggers: 0 });
  const { rows: functions } = await query(cluster, `select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any($1::text[])`, [catalog.functionNames]);
  assert.equal(functions[0].count, catalog.functionIdentities.length);
}

async function assertClean(cluster) {
  const { rows: ledger } = await query(cluster, "select version,name from supabase_migrations.schema_migrations order by version,name");
  assert.deepEqual(ledger, []);
  const { rows: objects } = await query(cluster, `select
    (select count(*)::int from pg_class where relnamespace='public'::regnamespace and relname=any($1::text[])) as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($2::text[])) as functions`,
  [catalog.tables, catalog.functionNames]);
  assert.deepEqual(objects[0], { tables: 0, functions: 0 });
}

async function waitForTaskBackend(cluster, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await query(cluster, `select count(*)::int as count from pg_stat_activity
      where application_name=$1 and backend_type='client backend' and wait_event_type='Lock' and wait_event='advisory'`, [applicationName]);
    if (rows[0].count === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("task-owned rehearsal backend did not reach its advisory barrier");
}

await withCluster({ historical: true }, async (cluster) => {
  const dependencies = localDependencies(cluster, { applicationName: "proplane-rehearsal-clean-install" });
  const outcome = await executeApprovedProductionApply(dependencies);
  assert.deepEqual(outcome, { outcome: "success", migrationCount: 12 },
    "clean install rolled back before COMMIT; normalize PostgreSQL trigger update_columns text arrays in the integrated catalog reader");
  assert.equal(dependencies.observedConnections.length, 2, "post-commit verification must use a fresh client");
  await assertInstalled(cluster, { historical: [HISTORICAL] });
});

await withCluster({}, async (cluster) => {
  const outcome = await executeApprovedProductionApply({ operation: "preflight", ...localDependencies(cluster, {
    applicationName: "proplane-rehearsal-preflight",
  }) });
  assert.equal(outcome.outcome, "preflight_passed");
  assert.equal(outcome.ledgerRows, 0);
  assert.equal(outcome.prerequisitesMissing, 0);
  assert.equal(outcome.targetObjectsAbsent, true);
  assert.equal(outcome.activity.other_sessions, 0);
  await assertClean(cluster);
});

for (const failure of ["before_bundle", "before_auxiliary", "before_precommit"]) {
  await withCluster({}, async (cluster) => {
    const outcome = await executeApprovedProductionApply(localDependencies(cluster, {
      failure, applicationName: `proplane-rehearsal-${failure}`,
    }));
    assert.deepEqual(outcome, { outcome: "rolled_back_or_refused", migrationCount: 12 }, failure);
    await assertClean(cluster);
  });
}

await withCluster({}, async (cluster) => {
  const applicationName = "proplane-rehearsal-bucket-race";
  const controller = new pg.Client(cluster.connection);
  let child;
  let childOutcome;
  let lockHeld = false;
  await controller.connect();
  try {
    await controller.query("select pg_advisory_lock(723081447303::bigint)");
    lockHeld = true;
    const dependencies = localDependencies(cluster, { applicationName });
    const originalFactory = dependencies.createClient;
    dependencies.createClient = (connection) => {
      const client = originalFactory(connection);
      const originalQuery = client.query.bind(client);
      client.query = async (...queryArgs) => {
        if ((typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text) === bundle) {
          await originalQuery("select pg_advisory_xact_lock(723081447303::bigint)");
        }
        return originalQuery(...queryArgs);
      };
      return client;
    };
    child = executeApprovedProductionApply(dependencies);
    await waitForTaskBackend(cluster, applicationName);
    await controller.query("insert into storage.buckets(id,name,public) values ('account-recovery','race',true)");
    await controller.query("select pg_advisory_unlock(723081447303::bigint)");
    lockHeld = false;
    childOutcome = await child;
    child = undefined;
  } finally {
    if (lockHeld) {
      try { await controller.query("select pg_advisory_unlock(723081447303::bigint)"); } catch { /* ending releases it */ }
    }
    await controller.end();
    if (child) {
      try { childOutcome = await child; } catch { /* the original harness failure remains authoritative */ }
    }
  }
  assert.deepEqual(childOutcome, { outcome: "rolled_back_or_refused", migrationCount: 12 });
  const { rows } = await query(cluster, "select id,name,public from storage.buckets where id='account-recovery'");
  assert.deepEqual(rows, [{ id: "account-recovery", name: "race", public: true }]);
  await assertClean(cluster);
});

for (const tls of ["untrusted", "hostname_mismatch"]) {
  await withCluster({}, async (cluster) => {
    await assert.rejects(executeApprovedProductionApply({ operation: "preflight", ...localDependencies(cluster, { tls }) }),
      (error) => error instanceof Error && error.message === "Production migration database connect failed. No credentials, SQL, or database output is displayed." &&
        !error.message.includes("local-rehearsal-password"));
    await assertClean(cluster);
  });
}

await withCluster({}, async (cluster) => {
  await assert.rejects(executeApprovedProductionApply({ operation: "preflight", ...localDependencies(cluster, { failure: "async_error" }) }),
    (error) => error instanceof Error && error.message === "Production migration driver asynchronous error failed. No credentials, SQL, or database output is displayed." &&
      !error.message.includes("synthetic-private-secret"));
  await assertClean(cluster);
});

await withCluster({}, async (cluster) => {
  const outcome = await executeApprovedProductionApply(localDependencies(cluster, { failure: "lost_commit_response" }));
  assert.deepEqual(outcome, { outcome: "uncertain_or_partial", migrationCount: 12 });
  await assertInstalled(cluster);
});

console.log("PASS: verified local TLS install, preflight, exact 13-row ledger, rollback points, owned-backend bucket race, TLS rejection, async redaction, and lost-COMMIT uncertainty.");
