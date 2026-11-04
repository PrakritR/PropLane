#!/usr/bin/env node
/** Exact one-migration operation. Default is read-only; production apply requires reviewed fresh restricted backup. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, openSync, closeSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { credential, connect } from './sms-durability-release-migrations.mjs';
const TARGETS={dev:'emstjswhotsnyksqhqyf',staging:'xwszcafaontidfgznlxd',production:'qahnczmilgptcedaqype'};
const VERSION='20261104120000';
const EXPECTED_HASH='37ee641a1886840e79b615879686d8205e4714e72c37f50913e5dc342e18d113';
const TABLES=['sms_ingress_envelopes','sms_platform_replies'];
const FUNCTIONS=['sms_ingress_claim(uuid,uuid,text,text)','sms_ingress_prepare(uuid,uuid,text,jsonb)','sms_ingress_checkpoint(uuid,uuid,text,text,text)','sms_ingress_reconcile(text,text)','sms_platform_reply_callback(uuid,text,text,text,text,text,text,integer)','purge_sms_ingress_retention()'];
const options={phase:'preflight'};
for(let i=2;i<process.argv.length;i++){
 const key=process.argv[i];
 if(key==='--target') options.target=process.argv[++i];
 else if(key==='--phase') options.phase=process.argv[++i];
 else if(key==='--backup-file') options.backup=process.argv[++i];
 else throw new Error('Unknown option');
}
assert.ok(Object.hasOwn(TARGETS,options.target),'Explicit target dev|staging|production required');
assert.ok(['preflight','backup','apply','postflight'].includes(options.phase),'Invalid phase');
const sql=readFileSync(new URL(`../supabase/migrations/${VERSION}_sms_durable_ingress.sql`,import.meta.url),'utf8');
const hash=createHash('sha256').update(sql).digest('hex'); assert.equal(hash,EXPECTED_HASH,'Reviewed migration bytes changed');
const project=TARGETS[options.target];
const db=await connect(credential(project));
async function snapshot(){
 const {rows:config}=await db.query('select line_mode,shared_number_e164,shared_messaging_service_sid,shared_pilot_workspace_ids from public.sms_runtime_config where singleton=true');
 const {rows:owner}=await db.query('select owner_user_id from public.platform_service_settings where singleton=true');
 const {rows:service}=await db.query('select id,owner_user_id,archived_at from public.portal_workspaces where is_service=true order by id');
 if(options.target==='production'){
  assert.equal(config.length,1); assert.equal(config[0].line_mode,'shared'); assert.equal(config[0].shared_number_e164,'+12066781909');
  assert.deepEqual(owner,[{owner_user_id:'f1aef049-7729-4edb-991f-89109464011e'}]);
  assert.deepEqual(service.map(r=>[r.id,r.owner_user_id,r.archived_at]),[
   ['c274ba4f-bf3f-41e0-b4ed-379ca578530f','c49d02b1-7e99-4484-9986-b3b4550c3519',null],
   ['e8cb8455-555f-42c4-b909-d83935181fd1','e60b7e18-6235-48ff-897a-3c1155a6f7b9',null]
  ]);
 }
 return JSON.parse(JSON.stringify({config,owner,service}));
}
async function assertAbsent(){
 for(const table of TABLES) assert.equal((await db.query('select to_regclass($1) object',[`public.${table}`])).rows[0].object,null,'Existing transport schema requires reconciliation');
 for(const fn of FUNCTIONS) assert.equal((await db.query('select to_regprocedure($1) object',[`public.${fn}`])).rows[0].object,null,'Existing transport function requires reconciliation');
 assert.equal((await db.query('select count(*)::int count from supabase_migrations.schema_migrations where version=$1',[VERSION])).rows[0].count,0,'Migration already recorded');
}
async function assertApplied(){
 const ledger=(await db.query('select statements from supabase_migrations.schema_migrations where version=$1',[VERSION])).rows;
 assert.equal(ledger.length,1); assert.deepEqual(ledger[0].statements,[sql]);
 for(const table of TABLES){
  const {rows:[acl]}=await db.query("select c.relrowsecurity rls,has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') authenticated,(has_table_privilege('service_role',$1,'SELECT') and has_table_privilege('service_role',$1,'INSERT') and has_table_privilege('service_role',$1,'UPDATE') and has_table_privilege('service_role',$1,'DELETE')) service from pg_class c where c.oid=to_regclass($1)",[`public.${table}`]);
  assert.equal(acl?.rls,true); assert.equal(acl.anon,false); assert.equal(acl.authenticated,false); assert.equal(acl.service,true);
 }
 for(const fn of FUNCTIONS){
  const {rows:[acl]}=await db.query("select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",[`public.${fn}`]);
  assert.equal(acl.anon,false); assert.equal(acl.authenticated,false); assert.equal(acl.service,true);
 }
}
function backupPath(){
 assert.ok(options.backup,'Explicit --backup-file required'); const path=resolve(options.backup);
 assert.equal(realpathSync(dirname(path)),'/private/tmp','Backup must be directly beneath /private/tmp'); return path;
}
try{
 await db.query('begin read only'); await db.query('set local role postgres');
 const before=await snapshot();
 if(options.phase==='postflight') await assertApplied(); else await assertAbsent();
 await db.query('rollback');
 if(options.phase==='backup'){
  const path=backupPath(); const fd=openSync(path,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify({version:1,project,migration:VERSION,hash,createdAt:new Date().toISOString(),schemaBefore:'absent',ledgerBefore:'absent',before},null,2));}finally{closeSync(fd);}
  console.log(JSON.stringify({target:options.target,project,phase:'backup',backupFile:path,hash,outcome:'restricted_backup_created'}));
 }else if(options.phase==='apply'){
  const path=backupPath(); const stat=statSync(path); assert.equal(stat.mode&0o777,0o600,'Backup permissions must be 0600');
  const backup=JSON.parse(readFileSync(path,'utf8')); assert.equal(backup.project,project); assert.equal(backup.hash,hash); assert.equal(backup.migration,VERSION);
  const age=Date.now()-Date.parse(backup.createdAt); assert.ok(age>=0&&age<2*60*60*1000,'Backup must be under two hours old');
  assert.equal(backup.schemaBefore,'absent'); assert.equal(backup.ledgerBefore,'absent'); assert.deepEqual(backup.before,before);
  await db.query('begin'); await db.query('set local role postgres'); await db.query("set local lock_timeout='3s'"); await db.query("set local statement_timeout='60s'");
  assert.equal((await db.query('select pg_try_advisory_xact_lock($1::bigint) acquired',[VERSION])).rows[0].acquired,true);
  await assertAbsent(); assert.deepEqual(await snapshot(),before);
  await db.query(sql);
  await db.query('insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)',[VERSION,'sms_durable_ingress',[sql]]);
  await assertApplied(); assert.deepEqual(await snapshot(),before);
  for(const table of TABLES) assert.equal((await db.query(`select count(*)::int count from public.${table}`)).rows[0].count,0);
  await db.query('commit');
  console.log(JSON.stringify({target:options.target,project,phase:'apply',hash,outcome:'committed_exact_migration_config_unchanged'}));
 }else console.log(JSON.stringify({target:options.target,project,phase:options.phase,hash,outcome:'verified_read_only'}));
}catch(error){await db.query('rollback').catch(()=>undefined); console.error('Exact ingress migration operation refused or failed; reconcile catalog and ledger before retry.'); throw error;}
finally{await db.end();}
