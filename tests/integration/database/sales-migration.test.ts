import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const port=process.env.ROOM_CAPACITY_TEST_PORT;
const owner="00000000-0000-4000-8000-000000000001", other="00000000-0000-4000-8000-000000000002";
const name=`sales_test_${randomUUID().replace(/-/g,"")}`;
describe.skipIf(!port)("real PostgreSQL migration transactions",()=>{
 let admin:Client,db:Client; const connections:Client[]=[]; let created=false;
 async function connect(database=name){const c=new Client({host:"127.0.0.1",port:Number(port),database,user:userInfo().username,connectionTimeoutMillis:3000,options:"-c statement_timeout=10000 -c lock_timeout=5000"});await c.connect();connections.push(c);return c;}
 beforeAll(async()=>{
  if(!/^\d+$/.test(port!)||Number(port)<1024||Number(port)>65535)throw Error("Explicit local test port required");
  admin=await connect("postgres");await admin.query(`create database "${name}"`);created=true;db=await connect();
  await db.query(`create schema auth; create table auth.users(id uuid primary key); insert into auth.users values('${owner}'),('${other}'); create function auth.uid() returns uuid language sql as 'select null::uuid'; create table public.ledger_entries(id uuid primary key,manager_user_id uuid,amount_cents bigint,entry_type text); create table public.manager_expense_entries(id uuid primary key,manager_user_id uuid,amount_cents bigint); create table public.manager_bills(id uuid primary key,manager_user_id uuid,property_id text,amount_cents bigint,status text);
  create table public.security_deposit_ledger(id uuid primary key,manager_user_id uuid,source_charge_id text,property_id text,unit_label text,lease_id text,resident_user_id uuid,resident_email text,amount_cents bigint,amount_held_cents bigint,received_date date,status text,disposition_type text,disposition_date date,itemization jsonb default '[]',disposition_journal_entry_id uuid,updated_at timestamptz);
  create table public.manager_bank_accounts(id uuid primary key,manager_user_id uuid);
  create table public.manager_bank_statements(id uuid primary key default gen_random_uuid(),manager_user_id uuid,bank_account_id uuid,statement_date date,opening_balance_cents bigint,closing_balance_cents bigint);
  create table public.manager_bank_statement_lines(id uuid primary key default gen_random_uuid(),statement_id uuid,line_date date,description text,amount_cents bigint,cleared boolean,matched_ledger_entry_id uuid);`);
  await db.query(await readFile("supabase/migrations/20260712090000_gl_journal.sql","utf8"));
  await db.query(await readFile("supabase/migrations/20260906082000_atomic_deposit_disposition.sql","utf8"));
  await db.query(await readFile("supabase/migrations/20260906083000_statement_file_intake.sql","utf8"));
  await db.query(await readFile("supabase/migrations/20260906084000_deposit_history_and_bill_limits.sql","utf8"));
  await db.query(await readFile("supabase/migrations/20260906085000_statement_match_targets.sql","utf8"));
 });
 afterAll(async()=>{for(const c of connections.filter(c=>c!==admin)){await c.query("rollback").catch(()=>{});await c.end();}if(created)await admin.query(`drop database "${name}"`);await admin?.end();});
 async function deposit(){const id=randomUUID();await db.query("insert into security_deposit_ledger(id,manager_user_id,source_charge_id,property_id,resident_email,amount_cents,amount_held_cents,received_date,status) values($1::uuid,$2,$1::text,'p','resident@example.test',60000,60000,'2026-01-01','held')",[id,owner]);return id;}
 const sql="select commit_security_deposit_disposition($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb) result";
 function args(id:string,history:unknown=null){return[owner,id,60000,20000,10000,"itemized_partial","2026-09-05",JSON.stringify(history??[]),"Reviewed",history?JSON.stringify(history):null];}
 it("imports dated refunds/deductions atomically and replays without duplicate journals",async()=>{const id=await deposit();const history=[{kind:"refund",amountCents:20000,date:"2026-02-01",sourceId:"r1",label:"Refund"},{kind:"deduction",amountCents:10000,date:"2026-03-01",sourceId:"d1",label:"Applied to rent"}];const a=await db.query(sql,args(id,history));expect(a.rows[0].result.amount_held_cents).toBe(30000);await db.query(sql,args(id,history));const rows=await db.query("select entry_date::text from gl_journal_entries where source_id like $1 order by entry_date",[`deposit:${id}:%`]);expect(rows.rows.map(r=>r.entry_date)).toEqual(["2026-02-01","2026-03-01"]);});
 it("rolls every journal back when a later history event is invalid",async()=>{const id=await deposit();const history=[{kind:"refund",amountCents:20000,date:"2026-02-01",sourceId:"a",label:"Refund"},{kind:"deduction",amountCents:10000,date:"invalid",sourceId:"b",label:"Bad"}];await expect(db.query(sql,args(id,history))).rejects.toThrow();expect((await db.query("select count(*)::int n from gl_journal_entries where source_id like $1",[`deposit:${id}:%`])).rows[0].n).toBe(0);expect((await db.query("select amount_held_cents::int n from security_deposit_ledger where id=$1",[id])).rows[0].n).toBe(60000);});
 it("arbitrates concurrent normal disposition and import before either extra journal posts",async()=>{const id=await deposit(),a=await connect(),b=await connect();await a.query("begin");await a.query(sql,args(id));const waiting=b.query(sql,args(id,[{kind:"refund",amountCents:20000,date:"2026-02-01",sourceId:"r",label:"Refund"},{kind:"deduction",amountCents:10000,date:"2026-03-01",sourceId:"d",label:"Deduction"}])).then(()=>"unexpected",e=>e.message);await a.query("commit");expect(await waiting).toMatch(/changed/);expect((await db.query("select count(*)::int n from gl_journal_entries where source_id like $1",[`deposit:${id}:%`])).rows[0].n).toBe(1);});
 it("refuses a different owner and non-service callers",async()=>{const id=await deposit();const input=args(id);input[0]=other;await expect(db.query(sql,input)).rejects.toThrow(/not found/);await db.query("set role authenticated");try{await expect(db.query(sql,args(id))).rejects.toThrow(/permission denied/);}finally{await db.query("reset role");}});
 it("imports a balanced statement once and refuses different values for the same file",async()=>{const account=randomUUID();await db.query("insert into manager_bank_accounts values($1,$2)",[account,owner]);const query="select import_bank_statement_file($1,$2,$3,$4,$5,$6::jsonb,$7,$8) id";const input=[owner,account,"2026-09-05",10000,17500,JSON.stringify([{lineDate:"2026-09-01",description:"Rent",amountCents:10000},{lineDate:"2026-09-02",description:"Repair",amountCents:-2500}]),"a".repeat(64),"statement.csv"];const id=(await db.query(query,input)).rows[0].id;expect((await db.query(query,input)).rows[0].id).toBe(id);expect((await db.query("select count(*)::int n from manager_bank_statement_lines where statement_id=$1",[id])).rows[0].n).toBe(2);input[4]=18000;await expect(db.query(query,input)).rejects.toThrow(/different reviewed/);input[6]="b".repeat(64);await expect(db.query(query,input)).rejects.toThrow(/equal closing/);});
 it("preserves imported deductions and refunds through an ordinary final disposition",async()=>{
  const id=await deposit(),history=[{kind:"refund",amountCents:20000,date:"2026-02-01",sourceId:"r",label:"Prior refund"},{kind:"deduction",amountCents:10000,date:"2026-03-01",sourceId:"d",label:"Prior rent deduction"}];
  await db.query(sql,args(id,history));
  const result=(await db.query(sql,[owner,id,30000,30000,0,"full_refund","2026-09-05","[]","Final refund",null])).rows[0].result;
  expect(result.itemization.slice(0,2)).toEqual(history);expect(result.itemization[2]).toMatchObject({kind:"refund",amountCents:30000,journalId:result.disposition_journal_entry_id});expect(result.amount_held_cents).toBe(0);
 });
 it("caps a shared repair bill across concurrent residents",async()=>{
  const one=await deposit(),two=await deposit(),bill=randomUUID();await db.query("insert into manager_bills values($1,$2,'p',10000,'approved')",[bill,owner]);
  const values=(id:string)=>[owner,id,60000,0,7000,"itemized_partial","2026-09-05",JSON.stringify([{kind:"deduction",amountCents:7000,label:"Repair",evidence:{billId:bill}}]),"Reviewed",null];
  const a=await connect(),b=await connect();await a.query("begin");await a.query(sql,values(one));const waiting=b.query(sql,values(two)).then(()=>"unexpected",e=>e.message);await a.query("commit");expect(await waiting).toMatch(/remaining cost/);expect((await db.query("select amount_held_cents::int amount from security_deposit_ledger where id=$1",[two])).rows[0].amount).toBe(60000);
 });
 it("matches expenses and refuses cross-owner, signed-amount and duplicate targets",async()=>{
  const statement=randomUUID(),expense=randomUUID(),receipt=randomUUID(),line=randomUUID(),second=randomUUID();
  await db.query("insert into manager_bank_statements(id,manager_user_id) values($1,$2)",[statement,owner]);await db.query("insert into manager_expense_entries values($1,$2,10000)",[expense,owner]);await db.query("insert into ledger_entries values($1,$2,10000,'payment')",[receipt,other]);
  await db.query("insert into manager_bank_statement_lines(id,statement_id,amount_cents) values($1,$3,-10000),($2,$3,-10000)",[line,second,statement]);
  await db.query("update manager_bank_statement_lines set matched_expense_entry_id=$1 where id=$2",[expense,line]);
  await expect(db.query("update manager_bank_statement_lines set matched_expense_entry_id=$1 where id=$2",[expense,second])).rejects.toThrow(/already matched/);
  await expect(db.query("update manager_bank_statement_lines set matched_ledger_entry_id=$1 where id=$2",[receipt,second])).rejects.toThrow(/belong/);
  await db.query("update ledger_entries set manager_user_id=$1 where id=$2",[owner,receipt]);
  await expect(db.query("update manager_bank_statement_lines set matched_ledger_entry_id=$1 where id=$2",[receipt,second])).rejects.toThrow(/signed bank amount/);
 });

});
