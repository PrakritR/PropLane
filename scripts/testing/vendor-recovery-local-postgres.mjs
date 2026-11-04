/** Disposable actual PostgreSQL lifecycle proof. Never accepts a remote database. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.env.VENDOR_RECOVERY_LOCAL_POSTGRES !== '1' || process.env.DATABASE_URL) throw Error('Explicit disposable-only recovery opt-in required');
process.env.VENDOR_LINK_LOCAL_POSTGRES = '1';
const { cluster, connect, install, stopCluster } = await import('./vendor-link-local-postgres.mjs');
const sql = name => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const migration = sql('20261104160000_vendor_recovery_boundaries.sql');
const manager='11111111-1111-4111-8111-111111111111', vendor='22222222-2222-4222-8222-222222222222';
const roots=['vendor_outreach_workspace_profiles','vendor_quote_contact_capabilities','vendor_quote_email_outbox','vendor_quote_email_permissions','vendor_quote_sms_consent_events','vendor_quote_sms_consent_challenges','vendor_sourcing_candidates','vendor_sourcing_jobs','vendor_coordination_phone_challenges','vendor_coordination_phone_bindings','vendor_coordination_reservations','vendor_coordination_proposals'];
const children=['vendor_quote_contact_sessions','vendor_quote_email_delivery_events','vendor_quote_responses','vendor_coordination_operations'];
const tables=[...roots,...children];
const canonical=['manager_vendor_records','portal_work_order_records','work_order_bids','portal_inbox_thread_records'];
async function one(db,q,args=[]){return (await db.query(q,args)).rows[0];}
async function setup(db){
 await install(db,true);
 await db.query(`alter table auth.users add column email text, add column raw_user_meta_data jsonb default '{}';
 alter table profiles add column role text,add column full_name text,add column preferred_language text,add column sms_opt_out_at timestamptz,add column sms_consent_at timestamptz;
 create table profile_roles(user_id uuid,role text,primary key(user_id,role));
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean);create table storage.objects(bucket_id text,name text);
 create table manager_property_records(id text primary key,manager_user_id uuid,workspace_id uuid);
 create table manager_sms_conversation_houses(manager_user_id uuid,conversation_key text,property_id text);
 create table account_link_invites(id uuid);create table audit_log(id uuid primary key,actor_user_id uuid not null);
 create table manager_application_records(id text primary key,manager_user_id uuid,resident_email text);
 create table screening_orders(id text primary key,application_id text);create table cosigner_submission_records(id text primary key,signer_app_id text);
 create table manager_sms_numbers(manager_user_id uuid,workspace_id uuid,phone_number text,messaging_service_sid text,provision_state text,released_at timestamptz);
 create table manager_assistant_emails(workspace_id uuid,manager_user_id uuid,mailbox_local text,inbox_token text,provision_state text);
 create table sms_consent(phone text primary key,opted_out_at timestamptz,opted_in_at timestamptz);
 alter table sms_consent_events add column occurred_at timestamptz default now(),add column wording_version text,add column evidence jsonb;
 alter table agent_sessions add column if not exists landlord_id uuid;alter table agent_sessions add column if not exists work_order_id text;alter table agent_sessions add column if not exists inbox_thread_id text;
 alter table agent_sessions add column if not exists vendor_user_id uuid;alter table agent_sessions add column if not exists vendor_phone_e164 text;alter table agent_sessions add column if not exists status text default 'active';alter table agent_sessions add column if not exists updated_at timestamptz default now();
 create unique index agent_sessions_vendor_wo_uidx on agent_sessions(work_order_id,vendor_directory_id);
 create table vendor_invoices(id uuid primary key,manager_user_id uuid,vendor_user_id uuid,amount_cents integer);
 create table vendor_payouts(id uuid primary key,manager_user_id uuid,vendor_user_id uuid,amount_cents integer);
 create table portal_inbox_thread_records(id text primary key,scope text,owner_user_id uuid,participant_email text,thread_type text,workspace_id uuid,row_data jsonb,updated_at timestamptz);
 create table portal_inbox_thread_aliases(alias_id text primary key,thread_id text not null);
 alter table portal_work_order_records add column assigned_property_id text;
 update auth.users set email=case when id='${manager}' then 'manager@example.test' else id||'@example.test' end;
 update profiles set role=case when id='${manager}' then 'manager' else 'vendor' end;
 insert into profile_roles select id,role from profiles;
 `);
 for(const file of ['20261104111000_vendor_quote_contact.sql','20261104112000_vendor_quote_inbox.sql','20261104121000_vendor_quote_inbox_current_main_compat.sql'])await db.query(sql(file));
 for(const table of ['ledger_entries','security_deposit_ledger','manager_payment_plans','portal_household_charge_records','portal_lease_pipeline_records'])await db.query(`create table ${table}(id uuid primary key,manager_user_id uuid,resident_user_id uuid,resident_email text,amount_cents integer,row_data jsonb)`);
 for(const file of ['20260907214100_preserve_resident_financial_history.sql','20260907224000_account_recovery_shared_retention.sql','20260907224500_account_recovery_snapshot.sql','20260907225000_account_recovery_identity_patches.sql','20260907225500_account_recovery_capture.sql','20260907230000_account_recovery_object_generations.sql','20260907231000_account_recovery_financial_access_keys.sql','20260907232000_account_recovery_restore.sql','20260907233000_account_recovery_finish_archival.sql','20261030145000_recovery_stored_roles_only.sql','20261104140000_vendor_legacy_approval_coordination_fence.sql'])await db.query(sql(file));
 // Historical installer predates these vendor tables in the live architecture.
 // Remove only the fixture-created vendor hooks to reproduce that actual upgrade state.
 for(const t of tables)await db.query(`drop trigger account_recovery_write_guard on ${t};drop trigger account_recovery_capture_delete on ${t}`);
}
async function exactHooks(db){
 const rows=(await db.query(`select c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgnargs,t.tgqual,t.tgconstraint::text,t.tgattr::text,t.tgisinternal,t.tgfoid=to_regprocedure('public.'||t.tgname||'()') exact from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname=any($1::text[]) and t.tgname in ('account_recovery_write_guard','account_recovery_capture_delete')`,[tables])).rows;
 assert.equal((await one(db,`select has_function_privilege('service_role','public.vendor_coordination_canonical_visits(uuid,text,text)','EXECUTE') allowed`)).allowed,false);
 assert.equal(rows.length,32);for(const r of rows){assert.equal(r.tgtype,r.tgname.endsWith('write_guard')?31:9);assert.equal(r.tgenabled,'O');assert.equal(r.tgnargs,0);assert.equal(r.tgqual,null);assert.equal(r.tgconstraint,'0');assert.equal(r.tgattr,'');assert.equal(r.tgisinternal,false);assert.equal(r.exact,true)}
}
async function rejectsInSavepoint(db,statement,pattern){await db.query('savepoint expected_rejection');await assert.rejects(db.query(statement),pattern);await db.query('rollback to savepoint expected_rejection');await db.query('release savepoint expected_rejection');}
async function conflicts(db){
 const table=roots[0];
 const cases=[
  `drop trigger account_recovery_write_guard on ${table};create trigger account_recovery_write_guard before insert on ${table} for each row execute function account_recovery_write_guard()`,
  `alter table ${table} disable trigger account_recovery_write_guard`,
  `drop trigger account_recovery_write_guard on ${table};create trigger account_recovery_write_guard before insert or update or delete on ${table} for each row when (true) execute function account_recovery_write_guard()`,
  `drop trigger account_recovery_write_guard on ${table};create trigger account_recovery_write_guard before insert or update of mode or delete on ${table} for each row execute function account_recovery_write_guard()`,
  `drop trigger account_recovery_write_guard on ${table};create trigger account_recovery_write_guard before insert or update or delete on ${table} for each row execute function account_recovery_write_guard('not allowed')`,
  `drop trigger account_recovery_capture_delete on ${table};create trigger account_recovery_capture_delete after delete on ${table} for each row execute function account_recovery_write_guard()`,
  `alter table vendor_quote_responses rename to missing_vendor_quote_responses`,
 ];
 for(const change of cases){await db.query('begin');try{await db.query(change);await rejectsInSavepoint(db,migration,/conflicts|missing/)}finally{await db.query('rollback')}}
}
async function approveActual(db,service,directory,visit,start,linked=true,prepareOnly=false){
 const resident='33333333-3333-4333-8333-333333333333';
 await db.query(`insert into manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,'{"name":"Calendar Vendor","email":"vendor@example.test"}') on conflict(id) do nothing`,[directory,manager,linked?vendor:null]);
 await db.query(`insert into portal_work_order_records(id,manager_user_id,resident_user_id,resident_email,property_id,row_data) values($1,$2,$3,'resident@example.test','property-1','{"bucket":"open"}')`,[service,manager,resident]);
 await db.query(`insert into work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,status,expires_at) values($1,$2,$3,$4,'sent',now()+interval '120 days')`,[service,manager,directory,linked?vendor:null]);
 let proposal=(await one(db,'select vendor_coordination_action($1::jsonb) result',[{kind:'enroll',work_order_id:service,vendor_directory_id:directory,visit_type:visit,manager_user_id:manager,actor_user_id:manager}])).result;
 const action=async(kind,actor,extra={})=>{proposal=(await one(db,'select vendor_coordination_action($1::jsonb) result',[{kind,proposal_id:proposal.id,expected_version:proposal.version,actor_user_id:actor,vendor_directory_id:directory,verified_phone_e164:'+13175550002',...extra}])).result;};
 const windows=[{startIso:start,endIso:new Date(Date.parse(start)+7200000).toISOString()}];
 await action('revise_quote',vendor,{quote:{laborCents:12000,materialsCents:2000,consultationFeeCents:5000,scope:'Canonical approved scope',exclusions:'No tile'},duration_minutes:60});
 await action('submit_vendor_windows',vendor,{windows,duration_minutes:60});await action('submit_resident_windows',resident,{windows});await action('select_time',manager,{selected_start_iso:start});await action('confirm_vendor',vendor);await action('confirm_resident',resident);if(!prepareOnly)await action('approve_manager',manager);
 return proposal;
}
async function reproduceConsultationGap(db){
 await db.query('begin');
 try{
  const proposal=await approveActual(db,'baseline-consult','baseline-directory','consultation','2026-12-20T12:00:00Z');
  await db.query('delete from vendor_coordination_proposals where id=$1',[proposal.id]);
  const conflicting=await approveActual(db,'baseline-conflict','baseline-directory','repair','2026-12-20T12:00:00Z');
  assert.equal(conflicting.status,'approved','old approval incorrectly ignores canonical consultation after operational deletion');
  console.log(JSON.stringify({scenario:'baseline-recovered-consultation-conflict-reproduced',passed:true}));
 }finally{await db.query('rollback')}
}
async function directoryOnlyCalendar(db){
 await db.query('begin');
 try{
  await db.query(`insert into manager_vendor_records(id,manager_user_id,row_data) values('only-directory',$1,'{"name":"Directory only"}')`,[manager]);
  await db.query(`insert into vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,phone_e164) values($1,'only-directory','+13175550002')`,[manager]);
  const p=await approveActual(db,'only-repair','only-directory','repair','2026-12-21T12:00:00Z',false);
  const service=await one(db,`select row_data from portal_work_order_records where id='only-repair'`);assert.equal(service.row_data.coordinationVendorPhoneE164,undefined);assert.equal((await one(db,`select row_data from manager_vendor_records where id='only-directory'`)).row_data.vendorCoordinationAppointmentEvidence['only-repair:repair'].phoneE164,'+13175550002');
  await db.query(`select set_config('proplane.vendor_coordination_write','off',true)`);
  await db.query(`update manager_vendor_records set row_data='{"name":"Edited unrelated field"}' where id='only-directory'`);
  assert.ok((await one(db,`select row_data from manager_vendor_records where id='only-directory'`)).row_data.vendorCoordinationAppointmentEvidence);
  await rejectsInSavepoint(db,`update manager_vendor_records set row_data=row_data||'{"vendorCoordinationAppointmentEvidence":{}}'::jsonb where id='only-directory'`,/server-owned/);
  await rejectsInSavepoint(db,`insert into manager_vendor_records(id,manager_user_id,row_data) values('forged-map','${manager}','{"vendorCoordinationAppointmentEvidence":{}}')`,/server-owned/);

  await db.query('delete from vendor_coordination_proposals where id=$1',[p.id]);await db.query(`delete from vendor_coordination_phone_bindings where vendor_directory_id='only-directory'`);
  await rejectsInSavepoint(db,`insert into vendor_availability_rules(vendor_user_id,kind,specific_date,start_minute,end_minute) values('${vendor}','block','2026-12-21',240,300)`,/canonical booked visit/);
  await db.query('savepoint conflict');await assert.rejects(approveActual(db,'only-conflict','linked-calendar','repair','2026-12-21T12:00:00Z'),/conflicting scheduled service/);await db.query('rollback to savepoint conflict');
  console.log(JSON.stringify({scenario:'directory-only-repair-canonical-phone-both-calendar-directions',passed:true}));
 }finally{await db.query('rollback')}
}
async function backfillEvidence(db){
 await db.query('begin');
 try{
  const p=await approveActual(db,'backfill-consult','backfill-directory','consultation','2026-12-22T12:00:00Z');
  await db.query(`update portal_work_order_records set row_data=row_data-'consultationVendorDirectoryId' where id='backfill-consult'`);
  await db.query(`update manager_vendor_records set row_data=row_data-'vendorCoordinationAppointmentEvidence' where id='backfill-directory'`);
  await db.query(migration);
  const row=await one(db,`select row_data from portal_work_order_records where id='backfill-consult'`);assert.equal(row.row_data.consultationVendorDirectoryId,'backfill-directory');assert.equal(row.row_data.consultationVendorPhoneE164,undefined);assert.equal((await one(db,`select row_data from manager_vendor_records where id='backfill-directory'`)).row_data.vendorCoordinationAppointmentEvidence['backfill-consult:consultation'].phoneE164,'+13175550002');
  await db.query('savepoint orphan');await db.query(`update portal_work_order_records set row_data=row_data||'{"consultationCoordinationProposalId":"00000000-0000-4000-8000-000000000000"}'::jsonb where id='backfill-consult'`);await rejectsInSavepoint(db,migration,/unprovable canonical participant/);await db.query('rollback to savepoint orphan');
  await db.query('savepoint mismatch');await db.query(`update portal_work_order_records set row_data=row_data||'{"consultationVisitAt":"2026-12-22T14:00:00Z"}'::jsonb where id='backfill-consult'`);await rejectsInSavepoint(db,migration,/unprovable canonical participant/);await db.query('rollback to savepoint mismatch');
  await db.query('delete from vendor_coordination_reservations where proposal_id=$1',[p.id]);
  await db.query(`update manager_vendor_records set row_data=row_data-'vendorCoordinationAppointmentEvidence' where id='backfill-directory'`);
  await rejectsInSavepoint(db,migration,/unprovable canonical participant|lacks one exact active participant/);
  console.log(JSON.stringify({scenario:'exact-approved-participant-backfill-and-missing-reservation-refusal',passed:true}));
 }finally{await db.query('rollback')}
}
async function seed(db){
 await db.query(`insert into manager_automation_settings(manager_user_id,vendor_dispatch) values($1,'{"quoteSourcingEnabled":true}')`,[manager]);
 await db.query(`insert into manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values('recovery-dir',$1,$2,'{"name":"Vendor","email":"vendor@example.test"}')`,[manager,vendor]);
 await db.query(`insert into portal_work_order_records(id,manager_user_id,vendor_user_id,resident_email,property_id,row_data) values('recovery-service',$1,$2,'resident@example.test','property-1','{"bucket":"scheduled","vendorId":"recovery-dir","scheduledAtIso":"2026-12-01T12:00:00Z","visitDurationMinutes":60,"quoteScope":"Repair faucet","quoteExclusions":"No tile"}')`,[manager,vendor]);
 const job=await one(db,`update vendor_sourcing_jobs set state='waiting',lease_token=gen_random_uuid(),lease_until=now()+interval '1 hour' where work_order_id='recovery-service' returning id`);
 const bid=await one(db,`insert into work_order_bids(work_order_id,manager_user_id,vendor_user_id,vendor_directory_id,amount_cents,materials_cents,note,status) values('recovery-service',$1,$2,'recovery-dir',12000,2000,'Repair faucet','accepted') returning id`,[manager,vendor]);
 const proposal=await one(db,`insert into vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,visit_type,status,accepted_bid_id,scope,labor_cents,materials_cents,consultation_fee_cents,duration_minutes) values('recovery-service',$1,'recovery-dir',$2,'repair','approved',$3,'Repair faucet',12000,2000,0,60) returning id`,[manager,vendor,bid.id]);
 const candidate=await one(db,`insert into vendor_sourcing_candidates(job_id,manager_user_id,stage,source,dedupe_key,contact,local_directory_id,proposal_id,status,expires_at) values($1,$2,0,'roster','recovery','{"email":"vendor@example.test"}','recovery-dir',$3,'quote_collected',now()+interval '1 day') returning id`,[job.id,manager,proposal.id]);
 const cap=await one(db,`insert into vendor_quote_contact_capabilities(token_digest,token_nonce,manager_user_id,job_id,candidate_id,work_order_id,vendor_directory_id,proposal_id,recipient_email,sender_mode,sender_version,sender_snapshot,expires_at) values(repeat('a',64),repeat('b',64),$1,$2,$3,'recovery-service','recovery-dir',$4,'vendor@example.test','software',1,'{}',now()+interval '1 day') returning id`,[manager,job.id,candidate.id,proposal.id]);
 await db.query(`insert into vendor_quote_contact_sessions(session_digest,capability_id,expires_at) values(repeat('c',64),$1,now()+interval '1 hour')`,[cap.id]);
 const outbox=await one(db,`insert into vendor_quote_email_outbox(candidate_id,job_id,manager_user_id,capability_id,message_kind,idempotency_key,job_lease_token,recipient_email,sender_key,sender_version,evidence_version,payload_hash,status) values($1,$2,$3,$4,'initial','recovery-outbox',gen_random_uuid(),'vendor@example.test','sender',1,1,repeat('f',64),'unknown') returning id`,[candidate.id,job.id,manager,cap.id]);
 await db.query(`insert into vendor_quote_email_delivery_events(event_id,outbox_id,provider_message_id,event_kind,occurred_at) values('recovery-delivery',$1,'provider-recorded','delivered',now())`,[outbox.id]);
 await db.query(`insert into vendor_quote_responses(capability_id,candidate_id,proposal_id,request_version,response_version,response) values($1,$2,$3,1,2,'{"scope":"Unapproved structured draft"}')`,[cap.id,candidate.id,proposal.id]);
 const challenge=await one(db,`insert into vendor_quote_sms_consent_challenges(capability_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,requested_phone,work_phone,messaging_service_sid,sender_version,proposal_version,code_digest,wording_version,expires_at) values($1,$2,$3,'recovery-dir',$4,'+13175550002','+13175550999','MGrecorded',1,1,repeat('f',64),'fixture-v1',now()+interval '1 hour') returning id`,[cap.id,manager,candidate.id,proposal.id]);
 await db.query(`insert into vendor_quote_sms_consent_events(capability_id,challenge_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,phone_e164,work_phone,messaging_service_sid,wording_version,source_event_id) values($1,$2,$3,$4,'recovery-dir',$5,'+13175550002','+13175550999','MGrecorded','fixture-v1','recorded-consent')`,[cap.id,challenge.id,manager,candidate.id,proposal.id]);
 await db.query(`insert into vendor_coordination_phone_challenges(manager_user_id,vendor_directory_id,phone_e164,code_hash,expires_at) values($1,'recovery-dir','+13175550002','never-replay-code',now()+interval '1 hour')`,[manager]);
 await db.query(`insert into vendor_coordination_reservations(proposal_id,work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,vendor_phone_e164,starts_at,ends_at) values($1,'recovery-service',$2,'recovery-dir',$3,'+13175550002','2026-12-01T12:00:00Z','2026-12-01T13:00:00Z')`,[proposal.id,manager,vendor]);
 await db.query(`insert into vendor_coordination_operations(proposal_id,source_message_id,action_kind,input_hash) values($1,'recorded-source','approve_manager','recorded-hash')`,[proposal.id]);
 await db.query(`insert into vendor_outreach_workspace_profiles(manager_user_id) values($1)`,[manager]);
 await db.query(`insert into vendor_quote_email_permissions(normalized_email,sender_key,manager_user_id,evidence_kind) values('vendor@example.test','sender',$1,'direct_permission')`,[manager]);
 await db.query(`insert into vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164) values($1,'recovery-dir',$2,'+13175550002')`,[manager,vendor]);
 await db.query(`insert into portal_inbox_thread_records(id,owner_user_id,row_data) values('recovery-inbox',$1,'{"messages":[{"text":"Approved repair history"}]}')`,[manager]);
 return{job:job.id,bid:bid.id,proposal:proposal.id,candidate:candidate.id,cap:cap.id};
}
async function lifecycle(db){
 const before=await seed(db);
 const consult=await approveActual(db,'recovery-consult','consult-directory','consultation','2026-12-20T12:00:00Z');
 const rules=[...roots.map(table=>({table,ids:['manager_user_id'],recover:false,phase:1})),...canonical.map(table=>({table,ids:[table==='portal_inbox_thread_records'?'owner_user_id':'manager_user_id'],recover:true,phase:2}))];
 const request=await one(db,`select account_recovery_begin($1,'manager',$2,'{"full_name":"Manager"}') id`,[manager,{complete:true,rules,recoverableTables:canonical}]);
 await db.query(`select set_config('proplane.account_recovery_internal','off',false)`);
 await db.query('begin');await rejectsInSavepoint(db,`update vendor_sourcing_candidates set reason='late write' where id='${before.candidate}'`,/recovery|Retained/);await rejectsInSavepoint(db,`insert into vendor_quote_contact_sessions(session_digest,capability_id,expires_at) values(repeat('e',64),'${before.cap}',now()+interval '1 hour')`,/retained|recovery/i);await db.query('rollback');
 for(const t of roots)await db.query(`delete from ${t} where manager_user_id=$1`,[manager]);
 await db.query(`delete from work_order_vendor_offers where manager_user_id=$1`,[manager]);
 await db.query(`delete from work_order_bids where manager_user_id=$1`,[manager]);
 await db.query(`delete from portal_work_order_records where manager_user_id=$1`,[manager]);
 await db.query(`delete from manager_vendor_records where manager_user_id=$1`,[manager]);
 await db.query(`delete from portal_inbox_thread_records where owner_user_id=$1`,[manager]);
 await db.query(`select account_recovery_finish_archival($1)`,[request.id]);
 const erased=(await db.query(`select table_name,payload,row_key,erased from account_recovery_records where table_name=any($1::text[])`,[tables])).rows;
 assert.equal(new Set(erased.map(row=>row.table_name)).size,16);for(const row of erased){assert.equal(row.erased,true);assert.equal(row.payload,null);assert.equal(row.row_key,null)}
 const eventCount=await one(db,'select count(*)::int n from action_events');
 await db.query(`select account_recovery_issue_challenge($1,$2,repeat('d',64))`,[request.id,manager]);
 await db.query(`select account_recovery_recover($1,$2,repeat('d',64))`,[request.id,manager]);
 for(const t of tables.filter(t=>t!=='vendor_sourcing_jobs'))assert.equal((await one(db,`select count(*)::int n from ${t}`)).n,0,`${t} must not return`);
 const jobs=(await db.query(`select id,state,lease_token,lease_until,attempts from vendor_sourcing_jobs`)).rows;assert.equal(jobs.length,2);for(const job of jobs){assert.notEqual(job.id,before.job);assert.equal(job.state,'dormant');assert.equal(job.lease_token,null);assert.equal(job.lease_until,null);assert.equal(job.attempts,0);}
 const service=await one(db,`select row_data from portal_work_order_records where id='recovery-service'`);assert.equal(service.row_data.quoteScope,'Repair faucet');assert.equal(service.row_data.quoteExclusions,'No tile');assert.equal(service.row_data.scheduledAtIso,'2026-12-01T12:00:00Z');
 assert.equal((await one(db,'select amount_cents from work_order_bids where id=$1',[before.bid])).amount_cents,12000);assert.equal((await one(db,`select row_data from portal_inbox_thread_records where id='recovery-inbox'`)).row_data.messages[0].text,'Approved repair history');
 const consultation=await one(db,`select row_data from portal_work_order_records where id='recovery-consult'`);assert.equal(consultation.row_data.consultationFeeCents,5000);assert.equal(consultation.row_data.consultationVisitAt,'2026-12-20T12:00:00Z');assert.equal(consultation.row_data.consultationVendorDirectoryId,'consult-directory');assert.equal(consultation.row_data.consultationVendorPhoneE164,undefined);assert.equal((await one(db,`select row_data from manager_vendor_records where id='consult-directory'`)).row_data.vendorCoordinationAppointmentEvidence['recovery-consult:consultation'].phoneE164,'+13175550002');assert.equal(consultation.row_data.consultationVendorUserId,undefined);
 await db.query('begin');await rejectsInSavepoint(db,`insert into vendor_availability_rules(vendor_user_id,kind,specific_date,start_minute,end_minute) values('${vendor}','block','2026-12-20',240,300)`,/canonical booked visit/);await db.query('rollback');
 await db.query('begin');try{await assert.rejects(approveActual(db,'recovery-conflict','consult-directory','repair','2026-12-20T12:00:00Z'),/conflicting scheduled service/)}finally{await db.query('rollback')}
 await assert.rejects(db.query('select vendor_coordination_action($1::jsonb)',[{kind:'approve_manager',proposal_id:consult.id,expected_version:consult.version,actor_user_id:manager}]),/proposal missing/);
 assert.equal((await one(db,'select count(*)::int n from action_events')).n,eventCount.n);
 assert.equal((await one(db,'select count(*)::int n from vendor_invoices')).n,0);assert.equal((await one(db,'select count(*)::int n from vendor_payouts')).n,0);
 await db.query(`insert into profile_roles(user_id,role) values('33333333-3333-4333-8333-333333333333','admin') on conflict do nothing`);
 const assigned=await one(db,`select (assign_vendor_outreach_mode($1,'software','33333333-3333-4333-8333-333333333333')).version version`,[manager]);assert.equal(assigned.version,1,'normal staff setup creates a new generation rather than replaying old authority');
 await assert.rejects(db.query(`select vendor_quote_capability_action(repeat('c',64),'{}')`),/unavailable/);
 await assert.rejects(db.query(`select vendor_coordination_action($1::jsonb)`,[{kind:'approve_manager',proposal_id:before.proposal,expected_version:1,actor_user_id:manager}]),/unavailable|not found|mismatch|proposal missing/);
 console.log(JSON.stringify({scenario:'actual-begin-purge-finish-recover',passed:true,oldAuthorityRestored:false,newJob:'fresh-dormant',canonicalBusinessRecordsPreserved:true,providerSends:0}));
}
async function vendorAcceptedRecovery(db){
 await db.query('begin');
 try{
  const p=await approveActual(db,'vendor-recovery-service','vendor-recovery-directory','repair','2026-12-25T12:00:00Z');
  const beforeP=await one(db,'select * from vendor_coordination_proposals where id=$1',[p.id]);
  const beforeWork=await one(db,`select row_data from portal_work_order_records where id='vendor-recovery-service'`);
  const bid=await one(db,'select * from work_order_bids where id=$1',[p.accepted_bid_id]);
  const rules=[{table:'manager_vendor_records',detachIds:['vendor_user_id'],recover:true,phase:3},{table:'portal_work_order_records',detachIds:['vendor_user_id'],recover:true,phase:3},{table:'vendor_coordination_proposals',detachIds:['vendor_user_id'],recover:false,phase:1},{table:'vendor_coordination_reservations',detachIds:['vendor_user_id'],recover:false,phase:1},{table:'work_order_bids',ids:['vendor_user_id'],recover:true,phase:1},{table:'work_order_vendor_offers',ids:['vendor_user_id'],recover:true,phase:1}];
  const request=await one(db,`select account_recovery_begin($1,'vendor',$2,'{"full_name":"Vendor"}') id`,[vendor,{complete:true,rules,recoverableTables:['manager_vendor_records','portal_work_order_records','work_order_bids','work_order_vendor_offers']}]);
  await db.query(`select set_config('proplane.account_recovery_internal','off',true)`);await db.query(`select set_config('proplane.vendor_coordination_write','off',true)`);
  await db.query('delete from work_order_bids where vendor_user_id=$1',[vendor]);await db.query('delete from work_order_vendor_offers where vendor_user_id=$1',[vendor]);
  assert.equal((await one(db,'select accepted_bid_id from vendor_coordination_proposals where id=$1',[p.id])).accepted_bid_id,null);
  await db.query('select account_recovery_finish_archival($1)',[request.id]);
  await db.query(`select account_recovery_issue_challenge($1,$2,repeat('8',64))`,[request.id,vendor]);
  await db.query(`select account_recovery_choose($1,$2,repeat('8',64),'recover')`,[request.id,vendor]);
  // Restore only canonical reference identities before proving the exact publication exception.
  const refs=(await db.query(`select r.id from account_recovery_records r join account_recovery_holds h on h.record_id=r.id where h.request_id=$1 and h.kind='reference' and r.table_name in ('manager_vendor_records','portal_work_order_records') order by r.table_name`,[request.id])).rows;
  await db.query(`select set_config('proplane.account_recovery_internal','on',true)`);
  for(const r of refs)await db.query('select account_recovery_restore_reference($1,$2)',[request.id,r.id]);
  const archived=await one(db,`select payload from account_recovery_records where table_name='work_order_bids' and row_key=jsonb_build_object('id',$1::uuid) and archived`,[bid.id]);
  const insert=payload=>db.query('insert into work_order_bids select (jsonb_populate_record(null::work_order_bids,$1::jsonb)).*',[payload]);
  await db.query('savepoint forged');await assert.rejects(insert({...archived.payload,amount_cents:1}),error=>error.code==='40001');await db.query('rollback to savepoint forged');
  await db.query('savepoint fake_id');await assert.rejects(insert({...archived.payload,id:'99999999-9999-4999-8999-999999999999'}),error=>error.code==='40001');await db.query('rollback to savepoint fake_id');
  await db.query('savepoint competing');
  await db.query(`insert into vendor_coordination_proposals(work_order_id,manager_user_id,vendor_directory_id,visit_type,status) values('vendor-recovery-service',$1,'vendor-recovery-directory','consultation','collecting')`,[manager]);
  await assert.rejects(insert(archived.payload),error=>error.code==='40001');await db.query('rollback to savepoint competing');
  const count=await one(db,'select count(*)::int n from action_events');const job=await one(db,`select state,lease_token,lease_until,attempts from vendor_sourcing_jobs where work_order_id='vendor-recovery-service'`);
  await db.query(`select account_recovery_recover($1,$2,repeat('8',64))`,[request.id,vendor]);
  assert.deepEqual(await one(db,'select * from work_order_bids where id=$1',[bid.id]),bid);
  const afterP=await one(db,'select * from vendor_coordination_proposals where id=$1',[p.id]);assert.equal(afterP.accepted_bid_id,bid.id);
  for(const key of Object.keys(beforeP).filter(key=>key!=='vendor_user_id'))assert.deepEqual(afterP[key],beforeP[key],`proposal ${key} unchanged`);
  assert.deepEqual((await one(db,`select row_data from portal_work_order_records where id='vendor-recovery-service'`)).row_data,beforeWork.row_data);
  assert.deepEqual(await one(db,`select state,lease_token,lease_until,attempts from vendor_sourcing_jobs where work_order_id='vendor-recovery-service'`),job);
  assert.equal((await one(db,'select count(*)::int n from action_events')).n,count.n);
  assert.equal((await one(db,'select count(*)::int n from vendor_coordination_phone_bindings where vendor_user_id=$1',[vendor])).n,0);
  console.log(JSON.stringify({scenario:'vendor-only-exact-accepted-bid-recovery-no-new-approval-or-automation',passed:true,forgedPrice:'refused',forgedPk:'refused',competingProposal:'refused'}));
 }finally{await db.query('rollback')}
}
async function vendorReferenceReassignment(db){
 await db.query('begin');
 try{
  const p=await approveActual(db,'reference-service','reference-directory','consultation','2026-12-28T12:00:00Z');
  const rules=['manager_vendor_records','vendor_coordination_proposals','vendor_coordination_reservations'].map(table=>({table,detachIds:['vendor_user_id'],recover:table==='manager_vendor_records',phase:1}));
  const a=await one(db,`select account_recovery_begin($1,'vendor',$2,'{}') id`,[vendor,{rules,recoverableTables:['manager_vendor_records']}]);
  await db.query(`select set_config('proplane.account_recovery_internal','off',true)`);await db.query(`select set_config('proplane.vendor_coordination_write','off',true)`);
  await db.query(`update manager_vendor_records set vendor_user_id='33333333-3333-4333-8333-333333333333' where id='reference-directory'`);
  await db.query(`update vendor_coordination_proposals set takeover_reason='Owner edited during deletion' where id=$1`,[p.id]);
  const before=await one(db,'select * from vendor_coordination_proposals where id=$1',[p.id]);const beforeReservation=await one(db,'select * from vendor_coordination_reservations where proposal_id=$1',[p.id]);const events=await one(db,'select count(*)::int n from action_events');
  await db.query('select account_recovery_finish_archival($1)',[a.id]);await db.query(`select account_recovery_issue_challenge($1,$2,repeat('7',64))`,[a.id,vendor]);await db.query(`select account_recovery_recover($1,$2,repeat('7',64))`,[a.id,vendor]);
  assert.equal((await one(db,`select vendor_user_id from manager_vendor_records where id='reference-directory'`)).vendor_user_id,'33333333-3333-4333-8333-333333333333');
  assert.deepEqual(await one(db,'select * from vendor_coordination_proposals where id=$1',[p.id]),before);
  assert.deepEqual(await one(db,'select * from vendor_coordination_reservations where proposal_id=$1',[p.id]),beforeReservation);assert.notEqual(beforeReservation.vendor_user_id,vendor);
  assert.equal((await one(db,'select count(*)::int n from action_events')).n,events.n);
  console.log(JSON.stringify({scenario:'surviving-manager-directory-reassignment-and-operational-edits-preserved',passed:true}));
 }finally{await db.query('rollback')}
}
async function directoryApprovalRaces(db){
 for(const first of ['approval','link']){
  const tag='lock-'+first,service=tag+'-service',directory=tag+'-directory',start=first==='approval'?'2026-12-26T12:00:00Z':'2026-12-27T12:00:00Z';
  await db.query(`insert into manager_vendor_records(id,manager_user_id,row_data) values($1,$2,'{"name":"Race vendor"}')`,[directory,manager]);
  await db.query(`insert into vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,phone_e164) values($1,$2,'+13175550002')`,[manager,directory]);
  const p=await approveActual(db,service,directory,'repair',start,false,true);
  const a=await connect(owned,'postgres'),b=await connect(owned,'postgres');
  const approve=c=>c.query('select vendor_coordination_action($1::jsonb)',[{kind:'approve_manager',proposal_id:p.id,expected_version:p.version,actor_user_id:manager}]);
  const link=c=>c.query('select link_vendor_directory_account($1,$2,$3)',[directory,manager,vendor]);
  try{
   await a.query('begin');await (first==='approval'?approve(a):link(a));
   const pending=(first==='approval'?link(b):approve(b));let blocked=false;
   for(let i=0;i<100;i++){if((await one(db,'select wait_event_type from pg_stat_activity where pid=$1',[b.processID]))?.wait_event_type==='Lock'){blocked=true;break}await new Promise(resolve=>setTimeout(resolve,10))}
   assert.ok(blocked,'second actual entrypoint must wait for canonical directory boundary');await a.query('commit');await pending;
   assert.equal((await one(db,'select status from vendor_coordination_proposals where id=$1',[p.id])).status,'approved');
   console.log(JSON.stringify({scenario:'actual-'+first+'-first-directory-approval-race',passed:true}));
  }finally{await a.query('rollback');await a.end();await b.end()}
  await db.query('delete from vendor_coordination_phone_bindings where vendor_directory_id=$1',[directory]);
 }
}
async function catalogEvidence(db){
 const expected=(await db.query(`select p.oid::text oid,p.proname name,p.proname||'()' signature,p.prorettype='pg_catalog.trigger'::regtype returns_trigger from pg_proc p where p.oid in (to_regprocedure('public.account_recovery_write_guard()'),to_regprocedure('public.account_recovery_capture_delete()'))`)).rows;
 const rows=[];
 for(const table of tables){
  const rel=await one(db,`select relkind from pg_class where oid=to_regclass($1)`,['public.'+table]);
  const triggers=(await db.query(`select t.tgname name,t.tgtype type,t.tgenabled enabled,p.proname||'()' function,t.tgfoid::text function_oid,t.tgnargs nargs,pg_get_expr(t.tgqual,t.tgrelid) qual,t.tgconstraint::text constraint_oid,t.tgattr::text attributes,t.tgisinternal internal from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid=to_regclass($1) and t.tgname in ('account_recovery_write_guard','account_recovery_capture_delete') order by t.tgname`,['public.'+table])).rows;
  rows.push({tbl:table,relkind:rel.relkind,triggers});
 }
 const evidence={provenance:'Disposable local PostgreSQL exact migration catalog; replace with fresh DEV capture after reviewed apply before release',migration_sha256:createHash('sha256').update(migration).digest('hex'),expected_functions:expected,rows};
 writeFileSync(new URL('../../tests/fixtures/recovery/vendor-hook-catalog-20261104.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
}
let owned,db;
try{owned=await cluster();db=await connect(owned,'postgres');await setup(db);await reproduceConsultationGap(db);await db.query(migration);await db.query(migration);await exactHooks(db);await conflicts(db);await backfillEvidence(db);await directoryOnlyCalendar(db);await lifecycle(db);await vendorAcceptedRecovery(db);await vendorReferenceReassignment(db);await directoryApprovalRaces(db);await catalogEvidence(db);console.log(JSON.stringify({result:'passed',exactHookTables:16,postgres:'real',providerSends:0}));}finally{if(db)await db.end();stopCluster(owned)}
