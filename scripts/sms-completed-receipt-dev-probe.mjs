#!/usr/bin/env node
/** DEV ONLY. All candidate DDL and synthetic rows are rolled back, including on failure. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { credential, connect } from './sms-durability-release-migrations.mjs';
const TARGET='emstjswhotsnyksqhqyf';
const OWNER='c02c7ffd-50ec-47d0-acf2-82928be6db27';
const OTHER='eae42709-255f-4316-80d1-bb3189e3f813';
const LINE='66666666-6666-4666-8666-666666666666';
const FROM='+15550009379', TO='+15550009252';
const sid=()=>`SM${randomUUID().replaceAll('-','')}`;
const sidA=sid(), sidB=sid(), burst=randomUUID();
const at=new Date(Date.now()-60_000).toISOString().replace(/(\.\d{3})Z$/, '$1456Z');
const original='\u00a0Original receipt probe: \u{1f680}\nKeep exact bytes.\uFEFF';
const migration=readFileSync(new URL('../supabase/migrations/20260926150000_sms_completed_receipt_originals.sql',import.meta.url),'utf8');
const digest=createHash('sha256').update(migration).digest('hex');
const c=await connect(credential(TARGET));
let began=false, cases=0;
async function resolveOriginal(id=sidA,owner=OWNER){return (await c.query('select public.resolve_sms_completed_receipt_original($1,$2) result',[id,owner])).rows[0].result;}
async function rejectedChange(sql,args,reason){await c.query('savepoint evidence_case');try{await c.query(sql,args);const result=await resolveOriginal();assert.equal(result.ok,false,reason);cases++;}finally{await c.query('rollback to savepoint evidence_case');await c.query('release savepoint evidence_case');}}
async function originalRows(id,body,revision){
  await c.query("insert into public.inbound_sms_log(manager_user_id,from_phone,to_phone,body,message_sid,counterparty_role,conversation_key,created_at) values($1,$2,$3,$4,$5,'prospect',$6,$7::timestamptz+interval '2 seconds')",[OWNER,FROM,TO,body,id,`${OWNER}:prospect:${FROM}`,at]);
  await c.query("insert into public.sms_inbound_receipts(message_sid,manager_user_id,recipient_phone_key,status,first_received_at,inbound_payload) values($1,$2,'5550009379','processing',$3,$4::jsonb)",[id,OWNER,at,JSON.stringify({body,fromPhone:FROM,toPhone:TO})]);
  await c.query("insert into public.prospect_sms_ingress(source_message_id,burst_id,manager_user_id,channel,burst_revision,body,received_at) values($1,$2,$3,'twilio',$4,left($5,2000),$6::timestamptz+interval '1 second')",[id,burst,OWNER,revision,body.trim(),at]);
}
let priorDefinition;
try{
  await c.query('begin');began=true;await c.query('set local role postgres');
  await c.query("set local lock_timeout='2s'");await c.query("set local statement_timeout='45s'");await c.query("set local idle_in_transaction_session_timeout='30s'");
  priorDefinition=(await c.query("select pg_get_functiondef(to_regprocedure('public.resolve_sms_completed_receipt_original(text,uuid)')) definition")).rows[0].definition;
  const line=(await c.query("select manager_user_id,phone_number,provision_state,coalesce(provisioned_at,requested_at) started_at from public.manager_sms_numbers where id=$1",[LINE])).rows[0];
  assert.equal(line?.manager_user_id,OWNER);assert.equal(line.phone_number,TO);assert.equal(line.provision_state,'active');assert.ok(Date.parse(line.started_at)<Date.parse(at));
  await c.query(migration);
  const acl=(await c.query("select has_function_privilege('anon','public.resolve_sms_completed_receipt_original(text,uuid)','EXECUTE') anon,has_function_privilege('authenticated','public.resolve_sms_completed_receipt_original(text,uuid)','EXECUTE') authenticated,has_function_privilege('service_role','public.resolve_sms_completed_receipt_original(text,uuid)','EXECUTE') service")).rows[0];
  assert.deepEqual(acl,{anon:false,authenticated:false,service:true});cases++;
  await c.query("insert into public.prospect_sms_bursts(id,manager_user_id,counterparty_phone_e164,counterparty_role,channel,reply_from_number,status,due_at) values($1,$2,$3,'prospect','sms',$4,'suppressed',now()+interval '1 day')",[burst,OWNER,FROM,TO]);
  await originalRows(sidA,original,1);
  let resolved=await resolveOriginal();assert.equal(resolved.ok,true);assert.equal(resolved.body,original);assert.equal(Date.parse(resolved.occurredAt),Date.parse(at));cases++;
  await c.query("update public.sms_inbound_receipts set status='completed',completed_at=now() where message_sid=$1",[sidA]);
  assert.equal((await c.query('select inbound_payload is null cleared from public.sms_inbound_receipts where message_sid=$1',[sidA])).rows[0].cleared,true);cases++;
  resolved=await resolveOriginal();assert.equal(resolved.ok,true);assert.equal(resolved.source,'durable_log');assert.equal(resolved.body,original);assert.equal(resolved.fromPhone,FROM);assert.equal(resolved.toPhone,TO);assert.equal(Date.parse(resolved.occurredAt),Date.parse(at));cases++;
  assert.equal((await resolveOriginal(sidA,OTHER)).ok,false);cases++;
  await rejectedChange('update public.inbound_sms_log set body=$2 where message_sid=$1',[sidA,'wrong body'],'body conflict');
  await rejectedChange('update public.inbound_sms_log set from_phone=$2 where message_sid=$1',[sidA,'+15550009001'],'sender conflict');
  await rejectedChange('update public.inbound_sms_log set to_phone=$2 where message_sid=$1',[sidA,'+15550009002'],'receiver conflict');
  await rejectedChange("update public.inbound_sms_log set counterparty_role='manager' where message_sid=$1",[sidA],'role conflict');
  await rejectedChange('update public.inbound_sms_log set matched_sender_user_id=$2 where message_sid=$1',[sidA,OTHER],'person conflict');
  await rejectedChange('update public.inbound_sms_log set manager_user_id=$2 where message_sid=$1',[sidA,OTHER],'owner conflict');
  await rejectedChange('update public.sms_inbound_receipts set recipient_phone_key=$2 where message_sid=$1',[sidA,'5550000000'],'sender key conflict');
  await c.query('savepoint pending_retained_history');
  try {
    await c.query("update public.sms_inbound_receipts set status='retryable' where message_sid=$1",[sidA]);
    const pending=await resolveOriginal();assert.equal(pending.ok,true);assert.equal(pending.status,'retryable');assert.equal(pending.source,'durable_log');
    const history=(await c.query("select public.import_sms_projection_historical_event('prospect_sms_ingress',$1) result",[sidA])).rows[0].result;
    assert.equal(history.inserted,true);
    const state=(await c.query(`select r.status,r.inbound_payload is null payload_null,t.occurred_at=r.first_received_at exact_time
      from public.sms_inbound_receipts r join public.sms_projection_turns t on t.id=$2 where r.message_sid=$1`,[sidA,history.turnId])).rows[0];
    assert.deepEqual(state,{status:'retryable',payload_null:true,exact_time:true});cases++;
    await c.query('delete from public.inbound_sms_log where message_sid=$1',[sidA]);
    assert.equal((await resolveOriginal()).ok,false,'pending receipt without original log accepted');cases++;
  } finally {await c.query('rollback to savepoint pending_retained_history');await c.query('release savepoint pending_retained_history');}
  await rejectedChange('delete from public.inbound_sms_log where message_sid=$1',[sidA],'missing transcript');
  await rejectedChange('delete from public.sms_inbound_receipts where message_sid=$1',[sidA],'missing receipt');
  await rejectedChange('update public.prospect_sms_bursts set reply_from_number=$2 where id=$1',[burst,'+15550009002'],'changed burst receiver');
  await rejectedChange('update public.prospect_sms_ingress set body=$2 where source_message_id=$1',[sidA,'arbitrary mismatch'],'queue conflict');
  await rejectedChange("update public.sms_inbound_receipts set status='processing',inbound_payload=$2::jsonb where message_sid=$1",[sidA,JSON.stringify({fromPhone:FROM,toPhone:TO})],'malformed present payload');
  // Missing/scalar/null fields must fail even without another body source.
  for (const payload of [{fromPhone:FROM,toPhone:TO},{body:null,fromPhone:FROM,toPhone:TO},null,[],42,{body:original,toPhone:TO},{body:original,fromPhone:FROM}]) {
    await c.query('savepoint malformed_without_log');
    try {
      await c.query('delete from public.prospect_sms_ingress where source_message_id=$1',[sidA]);
      await c.query('delete from public.inbound_sms_log where message_sid=$1',[sidA]);
      await c.query("update public.sms_inbound_receipts set status='processing',inbound_payload=$2::jsonb where message_sid=$1",[sidA,JSON.stringify(payload)]);
      assert.equal((await resolveOriginal()).ok,false,'malformed payload without secondary evidence');cases++;
    } finally {await c.query('rollback to savepoint malformed_without_log');await c.query('release savepoint malformed_without_log');}
  }
  // A transport holder may receive for a different workspace owner only when
  // the exact receiving epoch proves both identities together.
  await c.query('savepoint co_manager_case');
  try {
    const workspace=randomUUID();
    await c.query("insert into public.portal_workspaces(id,owner_user_id,name) values($1,$2,'Rollback SMS co-manager probe')",[workspace,OTHER]);
    await c.query('update public.manager_sms_numbers set workspace_id=$2 where id=$1',[LINE,workspace]);
    await c.query('update public.prospect_sms_bursts set manager_user_id=$2 where id=$1',[burst,OTHER]);
    await c.query('update public.prospect_sms_ingress set manager_user_id=$2 where source_message_id=$1',[sidA,OTHER]);
    const coManager=await resolveOriginal(sidA,OTHER);
    assert.equal(coManager.ok,true,JSON.stringify(coManager));assert.equal(coManager.owner,OTHER);assert.equal(coManager.receiptOwner,OWNER);assert.equal(coManager.workLineId,LINE);cases++;
    const logId=(await c.query('select id from public.inbound_sms_log where message_sid=$1',[sidA])).rows[0].id;
    const preferred=(await c.query("select public.import_sms_projection_historical_event('inbound_sms_log',$1) result",[logId])).rows[0].result;
    assert.equal(preferred.skipped,'prospect_ingress_preferred');cases++;
    await c.query('update public.manager_sms_numbers set manager_user_id=$2 where id=$1',[LINE,OTHER]);
    assert.equal((await resolveOriginal(sidA,OTHER)).ok,false,'workspace owner alone cannot authorize unrelated receipt holder');cases++;
  } finally {await c.query('rollback to savepoint co_manager_case');await c.query('release savepoint co_manager_case');}
  await c.query('savepoint overlapping_other_holder');
  try {
    const overlapWorkspace=randomUUID(),overlapLine=randomUUID();
    await c.query("insert into public.portal_workspaces(id,owner_user_id,name) values($1,$2,'Rollback overlapping epoch probe')",[overlapWorkspace,OWNER]);
    await c.query(`insert into public.manager_sms_numbers(id,manager_user_id,workspace_id,phone_number,provision_state,provisioned_at,released_at)
      values($1,$2,$3,$4,'released',$5::timestamptz-interval '1 day',$5::timestamptz+interval '1 day')`,[overlapLine,OTHER,overlapWorkspace,TO,at]);
    const proof=await resolveOriginal();assert.equal(proof.workLineId,LINE);
    await c.query('savepoint ambiguous_import');let ambiguityError;
    try {await c.query("select public.import_sms_projection_historical_event('prospect_sms_ingress',$1) result",[sidA]);}catch(error){ambiguityError=error;}
    await c.query('rollback to savepoint ambiguous_import');await c.query('release savepoint ambiguous_import');
    assert.equal(ambiguityError?.code,'23505','ambiguous importer did not report an identity conflict');assert.match(ambiguityError.message,/line|epoch/i);
    assert.equal(Number((await c.query('select count(*) n from public.sms_projection_turns where provider_sid=$1',[sidA])).rows[0].n),0);cases++;
  } finally {await c.query('rollback to savepoint overlapping_other_holder');await c.query('release savepoint overlapping_other_holder');}
  const imported=(await c.query("select public.import_sms_projection_historical_event('prospect_sms_ingress',$1) result",[sidA])).rows[0].result;
  assert.equal(imported.inserted,true,`import outcome: ${JSON.stringify(imported)}`);const turn=(await c.query('select body,occurred_at,from_phone,to_phone from public.sms_projection_turns where id=$1',[imported.turnId])).rows[0];assert.equal(turn.body,original);assert.equal(new Date(turn.occurred_at).getTime(),Date.parse(at));assert.equal(turn.from_phone,FROM);assert.equal(turn.to_phone,TO);cases++;
  assert.equal((await c.query(`select t.occurred_at=r.first_received_at exact_time from public.sms_projection_turns t
    join public.sms_inbound_receipts r on r.message_sid=$2 where t.id=$1`,[imported.turnId,sidA])).rows[0].exact_time,true,'microsecond receipt time changed');cases++;
  const replay=(await c.query("select public.import_sms_projection_historical_event('prospect_sms_ingress',$1) result",[sidA])).rows[0].result;assert.equal(replay.inserted,false);cases++;
  const unicode='\uFEFF'+ '\u{1f680}'.repeat(2001)+'\u00a0';await originalRows(sidB,unicode,2);await c.query("update public.sms_inbound_receipts set status='completed' where message_sid=$1",[sidB]);
  resolved=await resolveOriginal(sidB);assert.equal(resolved.ok,true);assert.equal(resolved.body,unicode);assert.equal((await c.query('select length(body) n from public.prospect_sms_ingress where source_message_id=$1',[sidB])).rows[0].n,2000);cases++;
  const unicodeImport=(await c.query("select public.import_sms_projection_historical_event('prospect_sms_ingress',$1) result",[sidB])).rows[0].result;assert.equal(unicodeImport.inserted,true);assert.equal((await c.query('select body from public.sms_projection_turns where id=$1',[unicodeImport.turnId])).rows[0].body,unicode);cases++;
  await c.query('savepoint preserved_legacy_log_key');
  try {
    const legacySid=sid(),legacyKey=`legacy-sms-probe:${randomUUID()}`;
    const log=(await c.query(`insert into public.inbound_sms_log(manager_user_id,from_phone,to_phone,body,message_sid,counterparty_role,conversation_key,created_at)
      values($1,$2,$3,$4,$5,'resident',$6,$7) returning id`,[OWNER,FROM,TO,original,legacySid,legacyKey,at])).rows[0];
    await c.query(`insert into public.sms_inbound_receipts(message_sid,manager_user_id,recipient_phone_key,status,first_received_at,inbound_payload)
      values($1,$2,'5550009379','completed',$3,null)`,[legacySid,OWNER,at]);
    const legacy=(await c.query("select public.import_sms_projection_historical_event('inbound_sms_log',$1) result",[log.id])).rows[0].result;
    assert.equal(legacy.inserted,true);
    const aliases=(await c.query("select alias_value from public.sms_projection_aliases where conversation_id=$1 and alias_kind='legacy_key'",[legacy.conversationId])).rows;
    assert.ok(aliases.some(row=>row.alias_value===legacyKey),'same-owner original legacy key was discarded');cases++;
  } finally {await c.query('rollback to savepoint preserved_legacy_log_key');await c.query('release savepoint preserved_legacy_log_key');}
  for (const retainedKey of [`retained-deleted-person:${randomUUID()}`,null]) {
    await c.query('savepoint unplaced_retained_identity');
    try {
      const unplacedSid=sid();
      const log=(await c.query(`insert into public.inbound_sms_log(manager_user_id,from_phone,to_phone,body,message_sid,counterparty_role,matched_sender_user_id,conversation_key,created_at)
        values($1,$2,'+15550009009',$3,$4,'resident',null,$5,$6) returning id`,[OWNER,FROM,original,unplacedSid,retainedKey,at])).rows[0];
      await c.query(`insert into public.sms_inbound_receipts(message_sid,manager_user_id,recipient_phone_key,status,first_received_at,inbound_payload)
        values($1,$2,'5550009379','completed',$3,null)`,[unplacedSid,OWNER,at]);
      const first=(await c.query("select public.import_sms_projection_historical_event('inbound_sms_log',$1) result",[log.id])).rows[0].result;
      assert.equal(first.inserted,true);
      const conversation=(await c.query('select identity_key,counterparty_user_id,work_line_id from public.sms_projection_conversations where id=$1',[first.conversationId])).rows[0];
      assert.equal(conversation.identity_key,retainedKey??`unresolved:inbound_sms_log:${log.id}`);assert.equal(conversation.counterparty_user_id,null);assert.notEqual(conversation.work_line_id,LINE);
      const replay=(await c.query("select public.import_sms_projection_historical_event('inbound_sms_log',$1) result",[log.id])).rows[0].result;
      assert.equal(replay.inserted,false);cases++;
    } finally {await c.query('rollback to savepoint unplaced_retained_identity');await c.query('release savepoint unplaced_retained_identity');}
  }
  // More than 2,000 events, including timestamp ties, must page without a
  // global cap, duplicates or gaps using the production keyset predicate.
  const conversationId=imported.conversationId;
  await c.query(`insert into public.sms_projection_turns(owner_manager_user_id,conversation_id,source_namespace,source_event_id,direction,body,occurred_at)
    select $1,$2,'rollback-scale-probe',$3||':'||n::text,'inbound','Scale event '||n::text,$4::timestamptz
    from generate_series(1,2001) n`,[OWNER,conversationId,burst,at]);
  let cursor=null,seen=new Set(),pages=0;
  for (;;) {
    const page=(await c.query(`select id,occurred_at::text stamp from public.sms_projection_turns
      where conversation_id=$1 and ($2::timestamptz is null or occurred_at<$2::timestamptz or (occurred_at=$2::timestamptz and id<$3::uuid))
      order by occurred_at desc,id desc limit 100`,[conversationId,cursor?.stamp??null,cursor?.id??null])).rows;
    if (!page.length)break;
    for (const row of page){assert.equal(seen.has(row.id),false,'keyset duplicate');seen.add(row.id);}
    cursor=page.at(-1);pages++;
  }
  assert.equal(seen.size,2003);assert.equal(pages,21);cases++;
  const indexes=(await c.query("select indexname from pg_indexes where schemaname='public' and indexname in ('sms_projection_turns_conversation_cursor_idx','manager_sms_numbers_historic_phone_epoch_idx','sms_inbound_receipts_payload_cursor_idx')")).rows;
  assert.equal(indexes.length,3);cases++;
  const cursorPlan=(await c.query(`explain (analyze,buffers,format json) select id,occurred_at from public.sms_projection_turns
    where conversation_id=$1 order by occurred_at desc,id desc limit 51`,[conversationId])).rows[0]['QUERY PLAN'][0];
  const nodes=[];function visit(node){nodes.push({type:node['Node Type'],index:node['Index Name']??null,rows:node['Actual Rows']});for(const child of node.Plans??[])visit(child);}
  visit(cursorPlan.Plan);
  assert.equal(cursorPlan.Plan['Actual Rows'],51);cases++;
  // On a small fixture, disable sequential scans only to demonstrate index
  // eligibility. These two plans are not throughput measurements.
  await c.query('set local enable_seqscan=off');
  const receiptPlan=(await c.query(`explain (format json) select message_sid,first_received_at from public.sms_inbound_receipts
    where inbound_payload is not null order by first_received_at,message_sid limit 100`)).rows[0]['QUERY PLAN'][0];
  const linePlan=(await c.query(`explain (format json) select id from public.manager_sms_numbers
    where phone_number=$1 and provision_state in ('active','released')
      and coalesce(provisioned_at,requested_at)<=$2::timestamptz
      and (released_at is null or $2::timestamptz<=released_at)`,[TO,at])).rows[0]['QUERY PLAN'][0];
  const indexNames=(plan)=>{const names=[];const walk=(node)=>{if(node['Index Name'])names.push(node['Index Name']);for(const child of node.Plans??[])walk(child);};walk(plan.Plan);return names;};
  assert.ok(indexNames(receiptPlan).includes('sms_inbound_receipts_payload_cursor_idx'));cases++;
  assert.ok(indexNames(linePlan).includes('manager_sms_numbers_historic_phone_epoch_idx'));cases++;
  console.log(JSON.stringify({target:'dev',eligibilityOnly:true,receiptIndexes:indexNames(receiptPlan),historicLineIndexes:indexNames(linePlan)}));
  console.log(JSON.stringify({target:'dev',scaleEvents:seen.size,pages,limit:100,firstPageQueryPlan:nodes,executionMs:cursorPlan['Execution Time']}));
  console.log(JSON.stringify({target:'dev',migrationSha256:digest,cases,completionTrigger:'payload_cleared',originalTime:'receipt_exact',unicode:'2001_astral_original_preserved',outcome:'passed_before_rollback'}));
} catch(e){console.error(JSON.stringify({target:'dev',migrationSha256:digest,cases,outcome:'failed',code:e.code??null,assertion:e.message?.startsWith('Expected')?'assertion_failed':e.message, location:e.stack?.split('\n').find(line=>line.includes('sms-completed-receipt-dev-probe.mjs'))}));process.exitCode=1;
} finally {
  if(began)await c.query('rollback');
  await c.query('begin read only');await c.query('set local role postgres');
  const current=(await c.query("select pg_get_functiondef(to_regprocedure('public.resolve_sms_completed_receipt_original(text,uuid)')) definition")).rows[0].definition;
  assert.equal(current,priorDefinition,'candidate DDL persisted');
  assert.equal(Number((await c.query('select count(*) n from public.prospect_sms_ingress where source_message_id=any($1::text[])',[[sidA,sidB]])).rows[0].n),0,'fixture persisted');
  await c.query('rollback');await c.end();console.log(JSON.stringify({target:'dev',rollback:'verified_no_candidate_ddl_or_fixture_persisted'}));
}
