/** Real local PostgreSQL proof: legacy accepted bids and coordination cannot both win. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { cluster, connect, install, stopCluster } from './vendor-link-local-postgres.mjs';
if (process.env.VENDOR_LEGACY_APPROVAL_LOCAL_POSTGRES !== '1' || process.env.DATABASE_URL) throw Error('Explicit disposable-only legacy approval opt-in required');
const manager='11111111-1111-4111-8111-111111111111',vendor='22222222-2222-4222-8222-222222222222';
const migration=readFileSync(new URL('../../supabase/migrations/20261104140000_vendor_legacy_approval_coordination_fence.sql',import.meta.url),'utf8');
async function seed(db,tag){
 const service=`legacy-${tag}`,directory=`legacy-dir-${tag}`;
 await db.query('insert into public.manager_vendor_records(id,manager_user_id,vendor_user_id,row_data) values($1,$2,$3,$4)',[directory,manager,vendor,{name:'Vendor',email:'vendor@example.test'}]);
 await db.query('insert into public.portal_work_order_records(id,manager_user_id,property_id,row_data) values($1,$2,$3,$4)',[service,manager,'property-1',{bucket:'open',title:'Repair'}]);
 await db.query("insert into public.work_order_vendor_offers(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,status,expires_at) values($1,$2,$3,$4,'sent',now()+interval '2 days')",[service,manager,directory,vendor]);
 const bid=(await db.query("insert into public.work_order_bids(work_order_id,manager_user_id,vendor_directory_id,vendor_user_id,amount_cents,status) values($1,$2,$3,$4,12000,'submitted') returning id",[service,manager,directory,vendor])).rows[0].id;
 return{service,directory,bid};
}
const enroll=(db,f)=>db.query('select public.vendor_coordination_action($1::jsonb)',[{kind:'enroll',work_order_id:f.service,vendor_directory_id:f.directory,visit_type:'repair',manager_user_id:manager,actor_user_id:manager}]);
const accept=(db,f)=>db.query("update public.work_order_bids set status='accepted' where id=$1 and status='submitted'",[f.bid]);
const outcome=async promise=>{try{await promise;return'00000'}catch(e){return e.code}};
async function verify(db,f,status,proposals){
 assert.equal((await db.query('select status from public.work_order_bids where id=$1',[f.bid])).rows[0].status,status);
 assert.equal((await db.query('select count(*)::int n from public.vendor_coordination_proposals where work_order_id=$1',[f.service])).rows[0].n,proposals);
}
let owned;
try{
 owned=await cluster();const db=await connect(owned,'postgres');
 try{
  await install(db,true);
  const old=await seed(db,'baseline');await enroll(db,old);await accept(db,old);
  assert.notEqual(await outcome(db.query("update public.portal_work_order_records set row_data=row_data||$2::jsonb where id=$1",[old.service,JSON.stringify({vendorId:old.directory})])),'00000');
  await verify(db,old,'accepted',1);
  await db.query('begin');assert.notEqual(await outcome(db.query(migration)),'00000');await db.query('rollback');
  await db.query('delete from public.work_order_bids where id=$1',[old.bid]);await db.query("update public.vendor_coordination_proposals set status='cancelled' where work_order_id=$1",[old.service]);
  await db.query(migration);await db.query(migration);
  console.log(JSON.stringify({scenario:'baseline-partial-accept-reproduced-and-preflight-refused',result:'passed'}));
  for(const first of ['enroll','accept']){
   const f=await seed(db,first),a=await connect(owned,'postgres'),b=await connect(owned,'postgres');
   try{
    await a.query('begin');
    if(first==='enroll'){
     await enroll(a,f);assert.equal(await outcome(accept(b,f)),'40001');await a.query('commit');await verify(db,f,'submitted',1);
    }else{
     await accept(a,f);const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;const pending=outcome(enroll(b,f));
     let blocked=false;for(let i=0;i<100;i++){const r=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];if(r?.wait_event_type==='Lock'){blocked=true;break}await delay(10)}
     assert.ok(blocked,'enrollment must be observed waiting for the same service boundary');await a.query('commit');assert.equal(await pending,'40001');await verify(db,f,'accepted',0);
     await db.query("update public.portal_work_order_records set row_data=row_data||$2::jsonb where id=$1",[f.service,JSON.stringify({vendorId:f.directory})]);
     assert.notEqual(await outcome(db.query('update public.work_order_bids set amount_cents=1 where id=$1',[f.bid])),'00000');
    }
    console.log(JSON.stringify({scenario:`${first}-first`,result:'passed'}));
   }finally{await a.query('rollback').catch(()=>{});await a.end();await b.end()}
  }
  const closed=await seed(db,'closed');await enroll(db,closed);await db.query("update public.vendor_coordination_proposals set status='cancelled' where work_order_id=$1",[closed.service]);await accept(db,closed);await verify(db,closed,'accepted',1);
  const coordinated=await seed(db,'coordinated');
  const resident='33333333-3333-4333-8333-333333333333';
  await db.query('update public.portal_work_order_records set resident_user_id=$2 where id=$1',[coordinated.service,resident]);
  await db.query("insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164) values($1,$2,$3,'+13175550002')",[manager,coordinated.directory,vendor]);
  let proposal=(await enroll(db,coordinated)).rows[0].vendor_coordination_action;
  const action=async(kind,actor,extra={})=>{proposal=(await db.query('select public.vendor_coordination_action($1::jsonb) result',[{kind,proposal_id:proposal.id,expected_version:proposal.version,actor_user_id:actor,vendor_directory_id:coordinated.directory,...extra}])).rows[0].result;};
  const start=new Date(Date.now()+7*86400000),end=new Date(start.getTime()+3*3600000),windows=[{startIso:start.toISOString(),endIso:end.toISOString()}];
  await action('revise_quote',vendor,{quote:{laborCents:12000,materialsCents:0,consultationFeeCents:0,scope:'Repair pipe',exclusions:''},duration_minutes:60});
  await action('submit_vendor_windows',vendor,{windows,duration_minutes:60});
  await action('submit_resident_windows',resident,{windows});
  await action('select_time',manager,{selected_start_iso:start.toISOString()});
  await action('confirm_vendor',vendor);await action('confirm_resident',resident);await action('approve_manager',manager);
  await verify(db,coordinated,'accepted',1);
  assert.equal((await db.query('select row_data from public.portal_work_order_records where id=$1',[coordinated.service])).rows[0].row_data.status,'Scheduled');
  assert.equal((await enroll(db,coordinated)).rows[0].vendor_coordination_action.status,'approved','exact enrollment retry retains approved proposal');
  console.log(JSON.stringify({scenario:'closed-proposals-release-and-real-coordinated-approval-with-retry',result:'passed'}));
  console.log(JSON.stringify({result:'passed',postgres:'real',providerSends:0}));
 }finally{await db.end()}
}finally{stopCluster(owned)}
