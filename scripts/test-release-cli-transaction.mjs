/**
 * Disposable proof for the exact Supabase CLI migration transport.
 *
 * This script is CI-only: it requires a throwaway PostgreSQL server and the
 * official pinned Linux CLI binary supplied by the workflow. It never targets
 * a linked Supabase project and needs no Supabase credentials.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cliTransactionGuardSql, doBlock, ledgerGuardSql } from './release-conversation-schema-reconciliation.mjs';

const [cli, adminDatabaseUrl, expectedServerVersion] = process.argv.slice(2);
if (!cli || !adminDatabaseUrl || !/^\d{6}$/.test(expectedServerVersion ?? '')) {
  throw new Error('usage: test-release-cli-transaction.mjs <supabase-cli> <disposable-db-url> <server-version-num>');
}
const parsedAdminUrl = new URL(adminDatabaseUrl);
if (!['postgres:', 'postgresql:'].includes(parsedAdminUrl.protocol) || parsedAdminUrl.hostname !== '127.0.0.1' || parsedAdminUrl.pathname !== '/postgres' || parsedAdminUrl.search || parsedAdminUrl.hash) {
  throw new Error('disposable loopback PostgreSQL admin URL required');
}

const workspaces = [];
const safeOutput = result => `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`.trim().slice(-6000);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? result.signal ?? 'spawn'}): ${safeOutput(result)}`);
  }
  return String(result.stdout ?? '').trim();
}
function psql(databaseUrl, sql) {
  return run('psql', ['-X', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--dbname', databaseUrl], { input: sql });
}
function databaseUrl(name) {
  const url = new URL(parsedAdminUrl);
  url.pathname = `/${name}`;
  // The official disposable postgres images do not enable TLS. This override
  // is created only after the strict loopback admin-URL check above and is
  // passed only to the CI rehearsal's derived databases.
  url.searchParams.set('sslmode', 'disable');
  url.hash = '';
  return url.toString();
}
function expectSql(database, sql, expected, label) {
  const actual = psql(database, sql).trim();
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
function createWorkspace(name) {
  const root = mkdtempSync(join(tmpdir(), `release-cli-${name}-`));
  workspaces.push(root);
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  writeFileSync(join(root, 'supabase', 'config.toml'), `project_id = "release-cli-${name}"\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n`);
  return root;
}
function writeMigration(workspace, identity, sql) {
  writeFileSync(join(workspace, 'supabase', 'migrations', `${identity}.sql`), `${sql.trim()}\n`);
}
function push(workspace, database, expectSuccess, marker = '') {
  const result = spawnSync(cli, ['db', 'push', '--db-url', database, '--skip-vault', '--include-all', '--yes'], {
    cwd: workspace,
    env: { ...process.env, NO_COLOR: '1', SUPABASE_TELEMETRY_DISABLED: 'true' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = safeOutput(result);
  if (expectSuccess && (result.error || result.signal || result.status !== 0)) throw new Error(`Supabase CLI push failed: ${output}`);
  if (!expectSuccess && !result.error && !result.signal && result.status === 0) throw new Error('Supabase CLI push unexpectedly succeeded');
  if (!expectSuccess && marker && !output.includes(marker)) throw new Error(`Supabase CLI failure omitted ${JSON.stringify(marker)}: ${output}`);
}

const transactionGuard = cliTransactionGuardSql({
  lockTimeout: '5s',
  statementTimeout: '30s',
  locks: [
    { relations: ['supabase_migrations.schema_migrations'], mode: 'exclusive' },
    { relations: ['public.transaction_probe'], mode: 'share row exclusive' },
  ],
  tag: 'cli_transaction_guard',
});

function prepareDatabase(name, historyFailure = false) {
  psql(adminDatabaseUrl, `create database ${name};`);
  const database = databaseUrl(name);
  psql(database, `
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text not null primary key, statements text[], name text);
create table public.transaction_probe(id integer primary key);
create function public.cli_transaction_value() returns text language sql stable as $$ select 'old'::text $$;
create function public.assert_cli_history_insert() returns trigger language plpgsql as $trigger$
begin
  ${historyFailure ? "raise exception 'forced history insert failure';" : `
  if not exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='supabase_migrations.schema_migrations'::regclass and mode='ExclusiveLock' and granted) then
    raise exception 'ledger lock missing at history insertion';
  end if;
  if not exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='public.transaction_probe'::regclass and mode='ShareRowExclusiveLock' and granted) then
    raise exception 'payload lock missing at history insertion';
  end if;`}
  ${historyFailure ? '' : `
  if current_setting('standard_conforming_strings') <> 'on'
     or current_setting('lock_timeout') <> '5s'
     or current_setting('statement_timeout') <> '30s' then
    raise exception 'transaction-local settings missing at history insertion';
  end if;`}
  return new;
end $trigger$;
create trigger assert_cli_history_insert before insert on supabase_migrations.schema_migrations
for each row execute function public.assert_cli_history_insert();
`);
  return database;
}

try {
  const version = run(cli, ['--version']);
  if (version !== '2.117.0') throw new Error(`Supabase CLI version differs: ${version}`);
  expectSql(adminDatabaseUrl, 'show server_version_num;', expectedServerVersion, 'PostgreSQL server version');

  const successDb = prepareDatabase('release_cli_success');
  const successWorkspace = createWorkspace('success');
  writeMigration(successWorkspace, '20260919010101_cli_transaction_success', `${transactionGuard}
alter table public.transaction_probe add column applied boolean not null default true;
create or replace function public.cli_transaction_value() returns text language sql stable as $function$ select 'new'::text $function$;`);
  push(successWorkspace, successDb, true);
  expectSql(successDb, `select (select public.cli_transaction_value())='new'
and exists(select 1 from information_schema.columns where table_schema='public' and table_name='transaction_probe' and column_name='applied')
and (select count(*)=1 from supabase_migrations.schema_migrations)
and (select name='cli_transaction_success' and cardinality(statements)>0 and array_to_string(statements,E'\\n') ilike '%alter table public.transaction_probe%' from supabase_migrations.schema_migrations where version='20260919010101');`, 't', 'successful DDL and truthful automatic history');

  const firstHistoryRow = psql(successDb, `select to_jsonb(m)::text from supabase_migrations.schema_migrations m where version='20260919010101';`);
  const successLedger = JSON.parse(psql(successDb, `select jsonb_agg(to_jsonb(m) order by version)::text from supabase_migrations.schema_migrations m;`));
  writeMigration(successWorkspace, '20260919010102_cli_transaction_recovery', `${transactionGuard}
${ledgerGuardSql(successLedger)}
${doBlock("begin if public.cli_transaction_value() is distinct from 'new' then raise exception 'recovery function precondition differs'; end if; end", 'cli_recovery_precondition')}
create or replace function public.cli_transaction_value() returns text language sql stable as $function$ select 'old'::text $function$;
${doBlock("begin if public.cli_transaction_value() is distinct from 'old' then raise exception 'recovery function postcondition differs'; end if; end", 'cli_recovery_postcondition')}`);
  push(successWorkspace, successDb, true);
  expectSql(successDb, `select (select public.cli_transaction_value())='old'
and (select count(*)=2 from supabase_migrations.schema_migrations)
and (select name='cli_transaction_recovery' and cardinality(statements)>0 and array_to_string(statements,E'\\n') ilike '%create or replace function public.cli_transaction_value%' from supabase_migrations.schema_migrations where version='20260919010102');`, 't', 'guarded recovery through the CLI transport');
  expectSql(successDb, `select to_jsonb(m)::text from supabase_migrations.schema_migrations m where version='20260919010101';`, firstHistoryRow, 'recovery preserves exact prior automatic history');

  const ddlFailureDb = prepareDatabase('release_cli_ddl_failure');
  const ddlFailureWorkspace = createWorkspace('ddl-failure');
  writeMigration(ddlFailureWorkspace, '20260919010201_cli_after_ddl_failure', `${transactionGuard}
alter table public.transaction_probe add column must_roll_back text;
create or replace function public.cli_transaction_value() returns text language sql stable as $function$ select 'changed'::text $function$;
do $after_ddl_failure$ begin raise exception 'forced after ddl failure'; end $after_ddl_failure$;`);
  push(ddlFailureWorkspace, ddlFailureDb, false, 'forced after ddl failure');
  expectSql(ddlFailureDb, `select not exists(select 1 from information_schema.columns where table_schema='public' and table_name='transaction_probe' and column_name='must_roll_back')
and not exists(select 1 from supabase_migrations.schema_migrations where version='20260919010201');`, 't', 'after-DDL error rollback');
  expectSql(ddlFailureDb, `select public.cli_transaction_value();`, 'old', 'after-DDL error rolls back function replacement');

  const historyFailureDb = prepareDatabase('release_cli_history_failure', true);
  const historyFailureWorkspace = createWorkspace('history-failure');
  writeMigration(historyFailureWorkspace, '20260919010301_cli_history_failure', `${transactionGuard}
alter table public.transaction_probe add column must_roll_back text;
create or replace function public.cli_transaction_value() returns text language sql stable as $function$ select 'changed'::text $function$;`);
  push(historyFailureWorkspace, historyFailureDb, false, 'forced history insert failure');
  expectSql(historyFailureDb, `select not exists(select 1 from information_schema.columns where table_schema='public' and table_name='transaction_probe' and column_name='must_roll_back')
and not exists(select 1 from supabase_migrations.schema_migrations where version='20260919010301');`, 't', 'history insertion failure rollback');
  expectSql(historyFailureDb, `select public.cli_transaction_value();`, 'old', 'history insertion failure rolls back function replacement');

  process.stdout.write(`${JSON.stringify({ cli: version, postgres: expectedServerVersion, success: true, recovery: true, afterDdlRollback: true, historyRollback: true, locksHeldAtHistoryInsert: true })}\n`);
} finally {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
}
