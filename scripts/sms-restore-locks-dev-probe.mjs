#!/usr/bin/env node
/** DEV-only, two connections; no row changes, every transaction rolls back. */
import assert from 'node:assert/strict';
import { credential, connect } from './sms-durability-release-migrations.mjs';
import { lockRestorePredicates, RESTORE_PREDICATE_LOCK_TABLES } from './sms-production-visible-original-log-restore.mjs';
const config=credential('emstjswhotsnyksqhqyf');
const a=await connect(config), b=await connect(config);
const cases=[
  ['line ownership update','update public.manager_sms_numbers set manager_user_id=manager_user_id where false'],
  ['workspace owner update','update public.portal_workspaces set owner_user_id=owner_user_id where false'],
  ['alternate manager insertion','insert into public.manager_sms_messages select * from public.manager_sms_messages where false'],
  ['alternate relay insertion','insert into public.sms_relay_messages select * from public.sms_relay_messages where false'],
  ['notice archive or delete','update public.portal_inbox_thread_records set row_data=row_data where false'],
];
let passed=0;
try {
  await a.query('begin');await a.query('set local role postgres');await a.query("set local lock_timeout='2s'");await a.query("set local statement_timeout='5s'");
  await lockRestorePredicates(a);
  for (const [name,sql] of cases) {
    await b.query('begin');await b.query('set local role postgres');await b.query("set local lock_timeout='250ms'");
    let error;
    try {await b.query(sql);}catch(e){error=e;}
    await b.query('rollback');assert.equal(error?.code,'55P03',`${name} did not conflict with restoration lock`);passed++;
  }
  await a.query('rollback');
  for (const [name,sql] of cases) {
    await b.query('begin');await b.query('set local role postgres');await b.query("set local lock_timeout='250ms'");
    const result=await b.query(sql);assert.equal(result.rowCount,0,`${name} unexpectedly changed rows`);await b.query('rollback');passed++;
  }
  console.log(JSON.stringify({target:'dev',cases:passed,lockedTables:RESTORE_PREDICATE_LOCK_TABLES,outcome:'competing_writers_blocked_then_released',rowChanges:0}));
} finally {await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});await a.end();await b.end();}
