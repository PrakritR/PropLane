/** Opt-in disposable local PostgreSQL smoke. Never points at a Supabase project. */
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const config = { host: '127.0.0.1', port: 55437, database: 'postgres', connectionTimeoutMillis: 3000 };
const lifecycle = new pg.Client(config), writer = new pg.Client(config), observer = new pg.Client(config);
await Promise.all([lifecycle.connect(), writer.connect(), observer.connect()]);
try {
  await Promise.all([lifecycle.query('set statement_timeout=5000'), writer.query('set statement_timeout=5000')]);
  await lifecycle.query("create schema if not exists recovery_lock_smoke");
  await lifecycle.query("create table if not exists recovery_lock_smoke.records(id integer)");
  const source = readFileSync('supabase/migrations/20260907225500_account_recovery_capture.sql', 'utf8');
  const guard = source.match(/if not pg_try_advisory_xact_lock_shared\(723081447301::bigint\) then[\s\S]*?end if;/)?.[0];
  assert.ok(guard, 'Use the actual migration lock guard');
  await lifecycle.query(`create or replace function recovery_lock_smoke.guard() returns trigger language plpgsql as $$ begin ${guard} return new; end $$`);
  await lifecycle.query('drop trigger if exists guard on recovery_lock_smoke.records');
  await lifecycle.query('create trigger guard before insert on recovery_lock_smoke.records for each row execute function recovery_lock_smoke.guard()');
  await lifecycle.query('begin');
  await lifecycle.query('select pg_advisory_xact_lock(723081447301::bigint)');
  await writer.query('begin');
  await writer.query('lock table recovery_lock_smoke.records in row exclusive mode');
  const pendingSnapshotLock = lifecycle.query('lock table recovery_lock_smoke.records in share row exclusive mode');
  // Confirm the lifecycle transaction is actually waiting on the writer's lock.
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    const result = await observer.query("select wait_event_type from pg_stat_activity where pid=$1", [lifecycle.processID]);
    if (result.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(waiting);
  await assert.rejects(writer.query('insert into recovery_lock_smoke.records values(1)'), error => error.code === '40001');
  await writer.query('rollback');
  await pendingSnapshotLock;
  await lifecycle.query('commit');
  await writer.query('insert into recovery_lock_smoke.records values(2)');
  console.log('PASS: conflicting writer returns 40001, snapshot proceeds, retry succeeds; no lock-order deadlock.');
} finally {
  await Promise.all([lifecycle.query('rollback'), writer.query('rollback')]);
  await lifecycle.query('drop schema if exists recovery_lock_smoke cascade');
  await Promise.all([lifecycle.end(), writer.end(), observer.end()]);
}
