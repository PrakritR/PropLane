#!/usr/bin/env node
/** A private disposable PostgreSQL exercise of the fixed apply runner. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import pg from "pg";
import { runFixedOperation } from "../apply-20260911-comms-billing-migrations.mjs";

const ROOT = process.cwd();
const OWNER = process.env.USER ?? "postgres";
const FIXTURE = join(ROOT, "scripts/testing/fixtures/production-migration-rehearsal-prerequisites.sql");
const RECOVERY = ["20260907130000_webhook_subscriptions.sql", "20260907214100_preserve_resident_financial_history.sql", "20260907221500_preserve_shared_vendor_financial_history.sql", "20260907223000_account_attachment_references.sql", "20260907224000_account_recovery_shared_retention.sql", "20260907224500_account_recovery_snapshot.sql", "20260907225000_account_recovery_identity_patches.sql", "20260907225500_account_recovery_capture.sql", "20260907230000_account_recovery_object_generations.sql", "20260907231000_account_recovery_financial_access_keys.sql", "20260907232000_account_recovery_restore.sql", "20260907233000_account_recovery_finish_archival.sql"];
const run = (file, args) => execFileSync(file, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });

function assertLocalPrerequisites() {
  for (const tool of ["initdb", "pg_ctl", "openssl"]) {
    try { run(tool, ["--version"]); }
    catch {
      throw new Error(`Local communication-billing harness requires PostgreSQL server tools (initdb and pg_ctl) and OpenSSL on PATH. Missing or unusable: ${tool}. Install PostgreSQL 16 server tools and OpenSSL, then add /usr/lib/postgresql/16/bin (or the local equivalent) to PATH.`);
    }
  }
}

function canonicalSpendSmsSegmentBudget() {
  const source = readFileSync(join(ROOT, "supabase/migrations/20260825120000_sms_control_plane.sql"), "utf8");
  const match = source.match(/create or replace function public\.spend_sms_segment_budget\(p_segments integer\)[\s\S]*?\n\$\$;/);
  if (!match || match[0].includes("select true")) throw new Error("Canonical spend_sms_segment_budget source is unavailable.");
  return match[0];
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function start({ tls = false } = {}) {
  const dir = mkdtempSync("/tmp/proplane-comms-apply-");
  const data = join(dir, "pg");
  const port = await freePort();
  try {
    run("initdb", ["-D", data, "--auth=trust", "--no-locale"]);
    let tlsOptions = "";
    let certificate;
    if (tls) {
      const key = join(dir, "server.key");
      const cert = join(dir, "server.crt");
      run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
      chmodSync(key, 0o600);
      certificate = readFileSync(cert, "utf8");
      tlsOptions = ` -c ssl=on -c ssl_cert_file=${cert} -c ssl_key_file=${key}`;
    }
    run("pg_ctl", ["-D", data, "-l", join(dir, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${dir}${tlsOptions}`, "-w", "start"]);
    return { dir, data, certificate, connection: { host: "127.0.0.1", port, user: OWNER, database: "postgres" } };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function stop(cluster) {
  try { run("pg_ctl", ["-D", cluster.data, "-m", "fast", "-w", "stop"]); }
  finally { rmSync(cluster.dir, { recursive: true, force: true }); }
}

async function withDb(connection, action) {
  const db = new pg.Client(connection);
  await db.connect();
  try { return await action(db); }
  finally { await db.end(); }
}

async function setup(connection) {
  await withDb(connection, async (db) => {
    await db.query("create extension if not exists pgcrypto");
    await db.query(readFileSync(FIXTURE, "utf8"));
    await db.query(`alter table public.profiles add column created_at timestamptz not null default now();
      create table public.manager_comms_billing_accounts(manager_user_id uuid primary key references public.profiles(id),monthly_budget_cents integer not null default 0,notified_budget_80_at timestamptz,notified_budget_100_at timestamptz,billing_paused_at timestamptz,billing_pause_reason text,updated_at timestamptz not null default now());
      create table public.manager_comms_usage_events(id uuid primary key default gen_random_uuid(),manager_user_id uuid not null references public.profiles(id),meter text not null default 'sms',quantity numeric not null default 1,unit_price_cents integer not null default 0,total_cents integer not null default 0,idempotency_key text unique,metadata jsonb not null default '{}',created_at timestamptz not null default now());
      create table public.manager_automation_settings(manager_user_id uuid primary key references public.profiles(id),row_data jsonb not null default '{}',manual_payments jsonb not null default '{}'::jsonb,updated_at timestamptz not null default now());
      create table public.sms_outbox(id uuid primary key default gen_random_uuid(),segment_count integer not null default 1,status text not null default 'queued',lease_owner text,lease_expires_at timestamptz);
      create table public.sms_runtime_config(singleton boolean primary key default true check(singleton),campaign_daily_segment_limit integer not null);
      insert into public.sms_runtime_config(singleton,campaign_daily_segment_limit) values(true,3);
      create table public.sms_segment_usage(usage_date date primary key,segment_count integer not null default 0,updated_at timestamptz not null default now());`);
    await db.query(canonicalSpendSmsSegmentBudget());
    await db.query("do $$ begin if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres superuser; end if; end $$");
    await db.query(`grant postgres, service_role to "${OWNER.replaceAll('"', '""')}"`);
    for (const file of RECOVERY) await db.query(readFileSync(join(ROOT, "supabase/migrations", file), "utf8"));
    await db.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('20260901000000','historical_fixture',array['unchanged'])");
  });
}

async function assertClean(connection) {
  await withDb(connection, async (db) => {
    const state = await db.query(`select
      (select count(*)::int from supabase_migrations.schema_migrations) ledger_rows,
      to_regclass('public.comms_credit_policy') is null objects_absent,
      not exists(select 1 from information_schema.columns where table_schema='public' and column_name='credit_state') columns_absent`);
    assert.deepEqual(state.rows[0], { ledger_rows: 1, objects_absent: true, columns_absent: true });
  });
}

async function exercise(mode) {
  const cluster = await start();
  try {
    await setup(cluster.connection);
    const clients = [];
    const calls = [];
    const execution = { interiorAttempts: 0, interiorCompleted: 0, injections: 0 };
    class InjectingClient extends pg.Client {
      constructor(config, inject) { super(config); this.inject = inject; this.auxInserted = false; }
      async query(sql, values) {
        calls.push(sql);
        if (this.inject === "auxiliary" && typeof sql === "string" && sql.startsWith("insert into supabase_migrations.schema_migrations")) throw new Error("injected auxiliary refusal");
        if (this.inject === "catalog" && this.auxInserted && typeof sql === "string" && sql.startsWith("select c.relname indexname")) throw new Error("injected catalog refusal");
        if ((this.inject === "timeout" || this.inject === "disconnect") && typeof sql === "string" && sql.startsWith("insert into supabase_migrations.schema_migrations")) {
          assert.equal(execution.interiorCompleted, 1, `${this.inject}: fault must be injected only after the bundle interior completes`);
          execution.injections += 1;
          assert.equal(execution.injections, 1, `${this.inject}: inject only once at the auxiliary boundary`);
          if (this.inject === "timeout") {
            await super.query("set local statement_timeout='50ms'");
            return super.query("select pg_sleep(1)");
          }
          const killer = new pg.Client(cluster.connection);
          await killer.connect();
          try { await killer.query("select pg_terminate_backend($1)", [this.processID]); }
          finally { await killer.end(); }
          return super.query(sql, values);
        }
        if (typeof sql === "string" && sql.includes("-- exact source:")) {
          execution.interiorAttempts += 1;
          const result = await super.query(sql, values);
          execution.interiorCompleted += 1;
          return result;
        }
        if (this.inject === "lost-commit" && sql === "COMMIT") {
          await super.query(sql, values);
          throw new Error("connection lost after commit");
        }
        const result = await super.query(sql, values);
        if (typeof sql === "string" && sql.startsWith("insert into supabase_migrations.schema_migrations")) this.auxInserted = true;
        return result;
      }
    }
    const createClient = (config) => {
      const client = new InjectingClient(config, clients.length === 0 ? mode : null);
      clients.push(client);
      return client;
    };
    const result = await runFixedOperation({ operation: "apply", target: "staging" }, { connection: cluster.connection, createClient });
    assert.equal(clients.length, 2, `${mode}: runner must use an independent readback and never replay`);
    assert.equal(execution.interiorAttempts, 1, `${mode}: bundle interior must be attempted exactly once`);
    assert.equal(execution.interiorCompleted, 1, `${mode}: bundle interior must complete exactly once`);
    assert.equal(calls.filter((sql) => typeof sql === "string" && sql.includes("-- exact source:")).length, 1, `${mode}: bundle interior must execute at most once`);
    if (mode === "timeout" || mode === "disconnect") {
      assert.equal(execution.injections, 1, `${mode}: inject exactly once after completed interior execution`);
      assert.equal(calls.includes("COMMIT"), false, `${mode}: must never reach COMMIT after injected transport fault`);
    }
    if (mode === "success") {
      assert.deepEqual(result, { outcome: "success", target: "staging", migrationCount: 6 });
      await withDb(cluster.connection, async (db) => {
        const rows = await db.query("select version,name from supabase_migrations.schema_migrations order by version,name");
        assert.equal(rows.rows.length, 8);
        assert.deepEqual(rows.rows[0], { version: "20260901000000", name: "historical_fixture" });
        assert.deepEqual(rows.rows.at(-1), { version: "20260911161000", name: "comms_billing_rollout" });
      });
      const verifyRejects = () => assert.rejects(
        runFixedOperation(
          { operation: "verify", target: "staging" },
          { connection: cluster.connection, createClient: (config) => new pg.Client(config) },
        ),
        /catalog verification/,
      );
      await withDb(cluster.connection, (db) => db.query("grant references(manager_user_id) on public.manager_comms_credit_purchases to anon"));
      await verifyRejects();
      await withDb(cluster.connection, (db) => db.query("revoke references(manager_user_id) on public.manager_comms_credit_purchases from anon"));
      await withDb(cluster.connection, (db) => db.query("drop index public.manager_billing_customer_unique; create unique index manager_billing_customer_unique on public.manager_comms_billing_accounts(manager_user_id,stripe_customer_id) where stripe_customer_id is not null"));
      await verifyRejects();
      await withDb(cluster.connection, (db) => db.query("drop index public.manager_billing_customer_unique; create unique index manager_billing_customer_unique on public.manager_comms_billing_accounts(stripe_customer_id) where stripe_customer_id is not null"));
      await withDb(cluster.connection, (db) => db.query("alter table public.manager_comms_usage_events drop constraint manager_comms_usage_events_quantity_check; alter table public.manager_comms_usage_events add constraint manager_comms_usage_events_quantity_check check(quantity>=0)"));
      await verifyRejects();
    } else if (mode === "lost-commit") {
      assert.equal(result.outcome, "uncertain_or_partial");
      assert.equal(calls.filter((sql) => sql === "COMMIT").length, 1);
      await withDb(cluster.connection, async (db) => assert.equal((await db.query("select count(*)::int n from supabase_migrations.schema_migrations")).rows[0].n, 8));
    } else if (mode === "disconnect") {
      assert.equal(result.outcome, "uncertain_or_partial");
      await assertClean(cluster.connection);
    } else {
      assert.equal(result.outcome, "rolled_back_or_refused");
      assert.equal(calls.includes("COMMIT"), false);
      await assertClean(cluster.connection);
    }
  } finally { await stop(cluster); }
}

assertLocalPrerequisites();
for (const mode of ["auxiliary", "catalog", "timeout", "disconnect", "success", "lost-commit"]) await exercise(mode);

const tlsCluster = await start({ tls: true });
try {
  const trusted = new pg.Client({ ...tlsCluster.connection, ssl: { ca: tlsCluster.certificate, servername: "localhost", rejectUnauthorized: true }, connectionTimeoutMillis: 2_000 });
  await trusted.connect();
  await trusted.end();
  await assert.rejects(new pg.Client({ ...tlsCluster.connection, ssl: { ca: tlsCluster.certificate, servername: "wrong.localhost", rejectUnauthorized: true }, connectionTimeoutMillis: 2_000 }).connect(), /Hostname\/IP does not match|not in the cert/i);
  await assert.rejects(new pg.Client({ ...tlsCluster.connection, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 2_000 }).connect(), /self-signed|unable to verify/i);
} finally { await stop(tlsCluster); }

console.log("PASS: fixed runner real-pg commit/readback, auxiliary and catalog rollback, timeout, async disconnect, lost-response no-replay, and local TLS trust rejection all held.");
