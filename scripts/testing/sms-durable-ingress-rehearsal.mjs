#!/usr/bin/env node
/** Transactional development/staging rehearsal. Never submits SMS or commits schema/data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { credential, connect } from '../sms-durability-release-migrations.mjs';
const targets = { dev: 'emstjswhotsnyksqhqyf', staging: 'xwszcafaontidfgznlxd' };
const target = process.argv[2];
if (!Object.hasOwn(targets, target)) throw new Error('Explicit dev|staging required; production rehearsal refused');
const db = await connect(credential(targets[target]));
try {
 await db.query('begin'); await db.query('set local role postgres'); await db.query("set local lock_timeout='3s'");
 const sql = readFileSync(new URL('../../supabase/migrations/20261104120000_sms_durable_ingress.sql', import.meta.url), 'utf8');
 await db.query(sql); await db.query(sql);
 for (const table of ['sms_ingress_envelopes','sms_platform_replies']) {
  const result = await db.query("select c.relrowsecurity rls,has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE') authenticated,has_table_privilege('service_role',$1,'SELECT,INSERT,UPDATE,DELETE') service from pg_class c where c.oid=to_regclass($1)", [`public.${table}`]);
  assert.equal(result.rows[0].rls,true); assert.equal(result.rows[0].anon,false); assert.equal(result.rows[0].authenticated,false); assert.equal(result.rows[0].service,true);
 }
 const token='11111111-1111-4111-8111-111111111111';
 const { rows:[envelope] }=await db.query("insert into sms_ingress_envelopes(message_sid,wire_from,wire_to,payload_digest,params,runtime,account_sid) values('SM' || repeat('0',32),'+12065550100','+12065550101',repeat('a',64),'{}','rehearsal','ACrehearsal') returning id");
 const claim=async()=> (await db.query('select sms_ingress_claim($1,$2,$3,$4) claim',[envelope.id,token,'rehearsal','ACrehearsal'])).rows[0].claim;
 assert.ok(await claim()); assert.equal(await claim(),null);
 const checkpoint=async(stage,control=null,sid=null,t=token)=> (await db.query('select sms_ingress_checkpoint($1,$2,$3,$4,$5) ok',[envelope.id,t,stage,control,sid])).rows[0].ok;
 assert.equal(await checkpoint('safe'),true); assert.equal(await checkpoint('control','START'),true);
 assert.equal(await checkpoint('control','STOP'),false); assert.equal(await checkpoint('safe'),false);
 assert.equal(await checkpoint('control','START',null,'22222222-2222-4222-8222-222222222222'),false);
 const bubbles=[{body:'Prepared first'},{body:'Prepared second',mediaUrls:['https://example.test/photo.jpg']}];
 const prepare=async(t)=> (await db.query('select sms_ingress_prepare($1,$2,$3,$4::jsonb) won',[envelope.id,t,'+12065550101',JSON.stringify(bubbles)])).rows[0].won;
 assert.equal(await prepare('22222222-2222-4222-8222-222222222222'),false); assert.equal(await prepare(token),true); assert.equal(await prepare(token),false);
 const {rows:replies}=await db.query('select * from sms_platform_replies where envelope_id=$1 order by bubble_index',[envelope.id]);
 assert.deepEqual(replies.map(r=>r.body),bubbles.map(r=>r.body)); assert.equal(replies.length,2);
 const reply=replies[0];
 const callback=async(overrides={})=>{
  const args={token:reply.callback_token,runtime:'rehearsal',account:'ACrehearsal',from:reply.wire_from,to:reply.wire_to,sid:'SM'+'1'.repeat(32),status:'delivered',rank:5,...overrides};
  return (await db.query('select sms_platform_reply_callback($1,$2,$3,$4,$5,$6,$7,$8) applied',Object.values(args))).rows[0].applied;
 };
 assert.equal(await callback(),false); // No provider attempt has been claimed.
 await db.query("update sms_platform_replies set status='submitting' where id=$1",[reply.id]);
 assert.equal(await callback({runtime:'production'}),false); assert.equal(await callback({to:'+12065550102'}),false);
 assert.equal(await callback(),true); assert.equal(await callback({sid:'SM'+'2'.repeat(32)}),false);
 assert.equal(await callback({status:'queued',rank:1}),true);
 const {rows:[bound]}=await db.query('select provider_sid,delivery_status from sms_platform_replies where id=$1',[reply.id]);
 assert.equal(bound.provider_sid,'SM'+'1'.repeat(32)); assert.equal(bound.delivery_status,'delivered');
 // Callback evidence can reopen only this suspension, preserving untouched bytes.
 await db.query("update sms_ingress_envelopes set status='needs_review',reason='delivery_unknown' where id=$1",[envelope.id]);
 await db.query("select sms_ingress_reconcile('rehearsal','ACrehearsal')");
 assert.equal((await db.query('select status from sms_ingress_envelopes where id=$1',[envelope.id])).rows[0].status,'prepared');
 await db.query("update sms_ingress_envelopes set status='needs_review',reason='reply_blocked' where id=$1",[envelope.id]);
 await db.query("select sms_ingress_reconcile('rehearsal','ACrehearsal')");
 assert.equal((await db.query('select status from sms_ingress_envelopes where id=$1',[envelope.id])).rows[0].status,'needs_review');
 await db.query("update sms_ingress_envelopes set reason='delivery_unknown' where id=$1",[envelope.id]);
 await db.query("update sms_platform_replies set status='blocked' where envelope_id=$1 and bubble_index=1",[envelope.id]);
 await db.query("select sms_ingress_reconcile('rehearsal','ACrehearsal')");
 assert.equal((await db.query('select status from sms_ingress_envelopes where id=$1',[envelope.id])).rows[0].status,'needs_review');
 await db.query("insert into sms_ingress_envelopes(message_sid,wire_from,wire_to,payload_digest,params,runtime,account_sid,expires_at) values('SM' || repeat('3',32),'+12065550100','+12065550101',repeat('b',64),'{}','rehearsal','ACrehearsal',now()-interval '1 second')");
 const {rows:[expired]}=await db.query("select sms_ingress_claim(id,$1,'rehearsal','ACrehearsal') claim from sms_ingress_envelopes where message_sid='SM' || repeat('3',32)",[token]); assert.equal(expired.claim,null);
 await db.query('rollback');
 console.log(JSON.stringify({target,project:targets[target],outcome:'rolled_back',checks:['migration_idempotency','RLS_and_table_ACL','claim_CAS','stale_prepare_refusal','ordered_prepared_bytes','callback_state_wire_runtime_SID_binding','monotonic_delivery','checkpoint_CAS_and_immutable_control','reason_scoped_reconciliation','expiry'],providerAttempts:0}));
} catch(error) { await db.query('rollback').catch(()=>undefined); throw error; }
finally { await db.end(); }
