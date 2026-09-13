import { beforeEach, expect, it, vi } from "vitest";
import { tourInterestProperty, followupDelivery, TOUR_INTEREST_BODY } from "@/lib/reminders/tour-interest";
import { DEFAULT_REMINDER_SETTINGS, normalizeReminderSettings } from "@/lib/reminders/rules";
const mocks=vi.hoisted(()=>({settings:vi.fn(),access:vi.fn(),consent:vi.fn(),materialize:vi.fn(),resolve:vi.fn(),enqueue:vi.fn()}));
vi.mock("@/lib/reminders/settings.server",()=>({loadReminderSettings:mocks.settings}));
vi.mock("@/lib/sms/conversation-house-access.server",()=>({loadAssignableConversationHouses:mocks.access}));
vi.mock("@/lib/sms/tour-sms-eligibility.server",()=>({resolveTourSmsEligibility:mocks.consent}));
vi.mock("@/lib/reminders/queue.server",()=>({materializeReminders:mocks.materialize,resolveReminder:mocks.resolve}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server",()=>({enqueueOwnerSms:mocks.enqueue}));
import { materializeTourInterestFromOutbox, tourInterestIsCurrent, tourInterestOutboxIsCurrent, dispatchTourInterestReminder } from "@/lib/reminders/subjects/tour-interest.server";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";
const anchor="2026-09-12T15:00:00Z", inboundAt="2026-09-12T14:59:00Z", phone="+12065550100", key="owner:prospect:+12065550100";
const fact={tool:"list_open_tour_slots",recordedAt:anchor,input:{propertyId:"house"},output:{resolution:"resolved",slots:[{slotKey:"slot"}]}};
const row:ReminderQueueRow={id:"reminder",managerUserId:"owner",kind:"tour_interest",subjectId:"subject",leadMinutes:-1440,
 recipientEmail:"",recipientPhone:phone,recipientRole:"counterparty",sendAt:"2026-09-13T15:00:00Z",attempts:0,
 payload:{propertyId:"house",actorUserId:"actor",inboundId:"inbound",responseOutboxId:"response",conversationKey:key,anchorIso:anchor,customBody:TOUR_INTEREST_BODY}};
type TestRow=Record<string,unknown>;
function fixture(){
 const tables:Record<string,TestRow[]>={
  manager_automation_settings:[{manager_user_id:"owner",tour_interest_enabled_at:"2026-09-12T14:00:00Z"}],
  manager_tour_followup_controls:[], manager_sms_messages:[{id:"inbound",manager_user_id:"owner",resident_phone:phone,direction:"inbound",created_at:inboundAt}],
  sms_outbox:[{id:"response",manager_user_id:"owner",actor_user_id:"actor",recipient_phone:phone,recipient_email:null,
   conversation_key:key,status:"submitted",dispatch_started_at:anchor,prospect_burst_id:"burst",purpose:"prospect_response"}],
  prospect_sms_bursts:[{id:"burst",candidate_context:[fact]}],
  portal_schedule_records:[{id:"axis_admin_partner_inquiries_v1",row_data:{payload:[]}},{id:"axis_admin_planned_events_v1",row_data:{payload:[]}}],
  manager_application_records:[],portal_reminder_records:[{id:row.id,manager_user_id:"owner",kind:"tour_interest",status:"sent",recipient_phone:phone,payload:row.payload}],
 };
 const errors=new Set<string>();
 const db={from(table:string){
  const filters:((r:TestRow)=>boolean)[]=[];const orders:{col:string;asc:boolean}[]=[];
  let limit=Infinity;const data=()=>{if(errors.has(table))return{data:null,error:new Error(`${table} unavailable`)};
   let result=(tables[table]??[]).filter(r=>filters.every(f=>f(r)));
   result=[...result].sort((a,b)=>{for(const o of orders){const n=String(a[o.col]??"").localeCompare(String(b[o.col]??""));if(n)return o.asc?n:-n;}return 0;});
   return{data:result.slice(0,limit),error:null};};
  const q={select(){return q;},eq(c:string,v:unknown){filters.push(r=>r[c]===v);return q;},in(c:string,v:unknown[]){filters.push(r=>v.includes(r[c]));return q;},
   order(c:string,o?:{ascending?:boolean}){orders.push({col:c,asc:o?.ascending!==false});return q;},limit(n:number){limit=n;return q;},
   maybeSingle(){const r=data();return Promise.resolve({...r,data:r.data?.[0]??null});},range(a:number,b:number){const r=data();return Promise.resolve({...r,data:r.data?.slice(a,b+1)??null});},
   then(resolve:(r:ReturnType<typeof data>)=>unknown){return Promise.resolve(data()).then(resolve);}};return q;
 }};
 return{db:db as never,tables,errors};
}
beforeEach(()=>{
 vi.resetAllMocks();mocks.settings.mockResolvedValue(normalizeReminderSettings({rules:{tour_interest:{enabled:true}}}));
 mocks.access.mockResolvedValue({assignable:new Map([["house",{ownerUserId:"owner"}]])});
 mocks.consent.mockResolvedValue({eligible:true,phoneE164:phone,conversationKey:key});
 mocks.materialize.mockResolvedValue(1);mocks.resolve.mockResolvedValue(true);mocks.enqueue.mockResolvedValue({ok:true,status:"queued",outboxId:"outbox"});
});
it("is off by default and cannot normalize extra messages/channels into the one-day rule",()=>{
 expect(DEFAULT_REMINDER_SETTINGS.rules.tour_interest.enabled).toBe(false);
 const s=normalizeReminderSettings({rules:{tour_interest:{enabled:true,timings:["after:5","after:10"],email:true}}});
 expect(s.rules.tour_interest.timings).toEqual(["after:1440"]);expect(s.rules.tour_interest.email).toBe(false);
});
it("requires current resolved nonempty availability facts",()=>{
 expect(tourInterestProperty([fact],inboundAt)).toBe("house");
 for(const output of [{},{resolution:"unavailable",slots:[{}]},{resolution:"resolved",slots:[]}])expect(tourInterestProperty([{...fact,output}],inboundAt)).toBeNull();
 expect(tourInterestProperty([{...fact,recordedAt:"2026-09-11"}],inboundAt)).toBeNull();
 expect(tourInterestProperty([fact],"bad")).toBeNull();
 expect(tourInterestProperty([fact,{tool:"request_tour",recordedAt:anchor,output:{ok:true}}],inboundAt)).toBeNull();
});
it("materializes one phone-only reminder from an accepted response without inventing email",async()=>{
 const f=fixture();expect(await materializeTourInterestFromOutbox(f.db,"response",new Date(anchor))).toBe(1);
 expect(mocks.materialize).toHaveBeenCalledWith(f.db,expect.objectContaining({kind:"tour_interest",anchorIso:anchor,
  recipients:[{email:"",phone,role:"counterparty"}],payload:expect.objectContaining({responseOutboxId:"response"})}),expect.anything(),new Date(anchor));
});
it("does not retroactively create a nudge for a pre-enable response",async()=>{
 const f=fixture();f.tables.manager_automation_settings[0].tour_interest_enabled_at="2026-09-12T15:01:00Z";
 expect(await materializeTourInterestFromOutbox(f.db,"response",new Date(anchor))).toBe(0);expect(mocks.materialize).not.toHaveBeenCalled();
});
it("does not create an overdue nudge during log repair",async()=>{
 const f=fixture();expect(await materializeTourInterestFromOutbox(f.db,"response",new Date("2026-09-14"))).toBe(0);expect(mocks.materialize).not.toHaveBeenCalled();
});
it.each(["queued","failed","unknown"])("ignores a response with %s provider outcome",async(status)=>{
 const f=fixture();f.tables.sms_outbox[0].status=status;expect(await materializeTourInterestFromOutbox(f.db,"response",new Date(anchor))).toBe(0);
});
it("cancels after a newer inbound, revoked access, or archive",async()=>{
 const f=fixture();expect(await tourInterestIsCurrent(f.db,row)).toBe(true);
 f.tables.manager_sms_messages[0].id="new-inbound";expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
 f.tables.manager_sms_messages[0].id="inbound";mocks.access.mockResolvedValue({assignable:new Map()});expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
 mocks.access.mockResolvedValue({assignable:new Map([["house",{ownerUserId:"owner"}]])});
 f.tables.manager_tour_followup_controls=[{manager_user_id:"owner",conversation_key:key,archived:true}];expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
});
it.each([0,1])("cancels when matching tour request/booking singleton %s contains the prospect",async(index)=>{
 const f=fixture();f.tables.portal_schedule_records[index].row_data={payload:[{managerUserId:"owner",phone,attendeePhone:phone}]};
 expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
});
it("cancels when a tour is filed under a different host for the same property",async()=>{
 const f=fixture();f.tables.portal_schedule_records[0].row_data={payload:[{managerUserId:"host",propertyId:"house",phone}]};
 expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
});
it("cancels when the prospect applies, using their stored phone",async()=>{
 const f=fixture();f.tables.manager_application_records=[{id:"app",manager_user_id:"owner",row_data:{application:{phone}}}];expect(await tourInterestIsCurrent(f.db,row)).toBe(false);
});
it("fails closed when schedules or archive state cannot be loaded",async()=>{
 const f=fixture();f.tables.portal_schedule_records=[];await expect(tourInterestIsCurrent(f.db,row)).rejects.toThrow("incomplete");
 const g=fixture();g.errors.add("manager_tour_followup_controls");await expect(tourInterestIsCurrent(g.db,row)).rejects.toThrow("unavailable");
});
it("binds the outbox to the stored phone, body, owner, property, actor and conversation",async()=>{
 const f=fixture();const input={managerUserId:"owner",actorUserId:"actor",recipientPhone:phone,conversationKey:key,propertyId:"house",body:TOUR_INTEREST_BODY};
 expect(await tourInterestOutboxIsCurrent(f.db,row.id,input)).toBe(true);
 for(const field of ["managerUserId","actorUserId","recipientPhone","conversationKey","propertyId","body"] as const){
  expect(await tourInterestOutboxIsCurrent(f.db,row.id,{...input,[field]:"other"})).toBe(false);
 }
});
it("refuses opt-out without enqueueing and keeps retry deduplication stable",async()=>{
 const f=fixture();mocks.consent.mockResolvedValueOnce({eligible:false,reason:"opted_out"});
 expect(await dispatchTourInterestReminder(f.db,"worker",row)).toBe("failed");expect(mocks.enqueue).not.toHaveBeenCalled();
 await dispatchTourInterestReminder(f.db,"worker",row);await dispatchTourInterestReminder(f.db,"worker",row);
 expect(mocks.enqueue.mock.calls.map(c=>c[0].dedupeKey)).toEqual(["tour-interest:reminder","tour-interest:reminder"]);
});
it("shows queued provider work as queued and never offers cancellation after submission",()=>{
 expect(followupDelivery({status:"sent"},{status:"queued"})).toEqual({status:"queued",canEdit:false,canCancel:true});
 expect(followupDelivery({status:"sent"},{status:"submitted",dispatch_started_at:anchor})).toEqual({status:"sending",canEdit:false,canCancel:false});
 expect(followupDelivery({status:"sent"},{status:"delivered",provider_message_sid:"SM"})).toEqual({status:"delivered",canEdit:false,canCancel:false});
 expect(followupDelivery({status:"cancelled"},{status:"queued"}).status).toBe("cancelled");
});
