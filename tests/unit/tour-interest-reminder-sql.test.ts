import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
let db: PGlite;
const owner="00000000-0000-0000-0000-000000000001", actor="00000000-0000-0000-0000-000000000002";
const reminder="00000000-0000-0000-0000-000000000003", outbox="00000000-0000-0000-0000-000000000004";
const key=`${owner}:prospect:+12065550100`, phone="+12065550100";
const payload={conversationKey:key,propertyId:"house",actorUserId:actor,inboundId:"inbound",customBody:"Still interested?",anchorIso:"2026-01-02T00:00:00Z"};
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create table auth.users(id uuid primary key);
 create table account_link_invites(id uuid); create table manager_property_records(id text); create table profiles(id uuid);
 create table manager_sms_conversation_houses(manager_user_id uuid,conversation_key text,property_id text);
 create table manager_automation_settings(manager_user_id uuid primary key,row_data jsonb);
 create table portal_reminder_records(id uuid primary key,manager_user_id uuid,kind text,subject_id text,lead_minutes integer,
 recipient_email text not null,recipient_role text,send_at timestamptz,status text,payload jsonb,updated_at timestamptz,lease_owner text,lease_expires_at timestamptz,sent_at timestamptz,last_error text);
 create table sms_outbox(id uuid primary key,manager_user_id uuid,actor_user_id uuid,purpose text,dedupe_key text,recipient_phone text,
 conversation_key text,property_id text,body text,status text,dispatch_started_at timestamptz,provider_message_sid text,lease_owner text,
 lease_expires_at timestamptz,provider_from_phone text,blocked_reason text,updated_at timestamptz);
 create table manager_sms_messages(id text,manager_user_id uuid,resident_phone text,direction text,created_at timestamptz);
 create function conversation_house_access_revision(uuid) returns text language sql as $$select 'revision'::text$$;`);
 await db.exec(readFileSync("supabase/migrations/20260912220000_tour_interest_reminders.sql","utf8"));
},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{
 await db.exec("truncate auth.users,manager_automation_settings,portal_reminder_records,sms_outbox,manager_sms_messages,manager_tour_followup_controls cascade");
 await db.query("insert into auth.users values($1),($2)",[owner,actor]);
 await db.query("insert into manager_automation_settings(manager_user_id,row_data) values($1,$2)",[owner,{reminderRules:{rules:{tour_interest:{enabled:true}}}}]);
 // Fixture sets a historic server enable time without defeating the production trigger.
 await db.exec("alter table manager_automation_settings disable trigger stamp_tour_interest_enabled_at");
 await db.query("update manager_automation_settings set tour_interest_enabled_at='2026-01-01' where manager_user_id=$1",[owner]);
 await db.exec("alter table manager_automation_settings enable trigger stamp_tour_interest_enabled_at");
 await db.query("insert into portal_reminder_records(id,manager_user_id,kind,subject_id,lead_minutes,recipient_phone,recipient_role,send_at,status,payload) values($1,$2,'tour_interest','subject',-1440,$3,'counterparty','2026-01-03','sending',$4)",[reminder,owner,phone,payload]);
 await db.query("insert into sms_outbox(id,manager_user_id,actor_user_id,purpose,dedupe_key,recipient_phone,conversation_key,property_id,body,status,lease_owner,lease_expires_at) values($1,$2,$3,'tour_interest_followup',$4,$5,$6,'house','Still interested?','claimed','worker',now()+interval '1 hour')",[outbox,owner,actor,`tour-interest:${reminder}`,phone,key]);
 await db.query("insert into manager_sms_messages values('inbound',$1,$2,'inbound','2026-01-02')",[owner,phone]);
});
async function mutate(action:string,id:string|null=reminder,allowed=["house"],revision="revision"){
 return (await db.query<{result:string}>("select change_tour_interest_followup($1,$2,$3,$4,$5,$6,now()+interval '1 day',$7,$8,'[]') result",[owner,actor,[key],action,id,"Edited",revision,allowed])).rows[0].result;
}
async function begin(){return (await db.query<{ok:boolean}>("select begin_tour_interest_submission($1,'worker','+12065550200') ok",[outbox])).rows[0].ok;}
async function state(){return (await db.query("select status from portal_reminder_records where id=$1",[reminder])).rows[0];}
it("admits the current reminder exactly once at the provider boundary",async()=>{expect(await begin()).toBe(true);expect(await begin()).toBe(false);});
it("cancels claimed delivery atomically and fences the stale worker",async()=>{expect(await mutate("cancel")).toBe("ok");expect(await begin()).toBe(false);expect(await state()).toEqual({status:"cancelled"});});
it("refuses cancellation once provider submission starts",async()=>{expect(await begin()).toBe(true);expect(await mutate("cancel")).toBe("started");expect(await state()).toEqual({status:"sending"});});
it.each(["submitted","sent","delivered","unknown"])("never relabels %s provider history as cancelled",async(status)=>{
 await db.query("update sms_outbox set status=$1,dispatch_started_at=now()",[status]);
 expect(await mutate("cancel")).toBe("started");expect(await state()).toEqual({status:"sending"});
 expect(await mutate("archive",null)).toBe("ok");expect(await state()).toEqual({status:"sending"});
});
it("sets an archive barrier even before a reminder exists",async()=>{
 await db.exec("delete from portal_reminder_records");expect(await mutate("archive",null)).toBe("ok");
 expect((await db.query("select archived from manager_tour_followup_controls")).rows).toEqual([{archived:true}]);
 expect(await mutate("restore",null)).toBe("ok");expect((await db.query("select archived from manager_tour_followup_controls")).rows).toEqual([{archived:false}]);
});
it("rolls back archive state when a row lacks permission",async()=>{
 await expect(mutate("archive",null,[])).rejects.toThrow(/access changed/);
 expect((await db.query("select * from manager_tour_followup_controls")).rows).toEqual([]);
});
it("rejects stale authorization before changing anything",async()=>{expect(await mutate("cancel",reminder,["house"],"stale")).toBe("stale");expect(await state()).toEqual({status:"sending"});});
it("cannot edit a reminder that already has a queued outbox",async()=>{
 await db.exec("update portal_reminder_records set status='scheduled'; update sms_outbox set status='queued'");
 expect(await mutate("edit")).toBe("started");
});
it("edits scheduled text only before it is claimed",async()=>{
 await db.exec("delete from sms_outbox; update portal_reminder_records set status='scheduled'");expect(await mutate("edit")).toBe("ok");
 expect((await db.query("select payload->>'customBody' body from portal_reminder_records")).rows).toEqual([{body:"Edited"}]);
});
it("rejects new inbound at the submission boundary",async()=>{await db.query("insert into manager_sms_messages values('new',$1,$2,'inbound',now())",[owner,phone]);expect(await begin()).toBe(false);});
it("rejects disabled settings and stale enable cutoffs",async()=>{
 await db.query("update manager_automation_settings set row_data=$1",[{reminderRules:{rules:{tour_interest:{enabled:false}}}}]);expect(await begin()).toBe(false);
 await db.query("update manager_automation_settings set row_data=$1",[{reminderRules:{rules:{tour_interest:{enabled:true}}}}]);expect(await begin()).toBe(false);
});
it("rejects changed recipient identity or copied body",async()=>{await db.exec("update sms_outbox set body='Unexpected body'");expect(await begin()).toBe(false);});
it("does not allow missing phone AND email",async()=>{await expect(db.exec("update portal_reminder_records set recipient_phone=null")).rejects.toThrow(/recipient_check/);});
it.each(["anon","authenticated"])("keeps cancellation/submission RPCs private from %s",async(role)=>{
 const rows=await db.query("select has_function_privilege($1,'begin_tour_interest_submission(uuid,text,text)','execute') submit,has_function_privilege($1,'change_tour_interest_followup(uuid,uuid,text[],text,uuid,text,timestamptz,text,text[],jsonb)','execute') change",[role]);
 expect(rows.rows).toEqual([{submit:false,change:false}]);
});

it("uses the existing lease CAS to mark a stale reminder cancelled",async()=>{
 await db.exec("update portal_reminder_records set lease_owner='worker'");
 expect((await db.query<{ok:boolean}>("select resolve_reminder($1,'other','cancelled','stale') ok",[reminder])).rows[0].ok).toBe(false);
 expect((await db.query<{ok:boolean}>("select resolve_reminder($1,'worker','cancelled','stale') ok",[reminder])).rows[0].ok).toBe(true);
 expect(await state()).toEqual({status:"cancelled"});
});
it("treats sent reminders with missing outbox evidence as unknown, not cancellable",async()=>{
 await db.exec("delete from sms_outbox; update portal_reminder_records set status='sent'");
 expect(await mutate("cancel")).toBe("started");
 expect(await state()).toEqual({status:"sent"});
});
