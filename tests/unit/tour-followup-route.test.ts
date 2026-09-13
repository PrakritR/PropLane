import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({auth:vi.fn(),fetch:vi.fn(),access:vi.fn(),scope:vi.fn(),tags:vi.fn(),rpc:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/auth/portal-access",()=>({getPortalAccessContext:mocks.auth,hasRole:(ctx:{roles:string[]},role:string)=>ctx.roles.includes(role),hasAdminRole:()=>false}));
vi.mock("@/lib/supabase/service",()=>({createSupabaseServiceRoleClient:()=>({from:mocks.from,rpc:mocks.rpc})}));
vi.mock("@/lib/manager-sms-messages.server",()=>({fetchManagerSmsConversations:mocks.fetch}));
vi.mock("@/lib/auth/co-manager-module-scope",()=>({linkedOwnerScopeForModule:mocks.scope}));
vi.mock("@/lib/sms/conversation-houses.server",()=>({loadConversationHouseScope:mocks.tags}));
vi.mock("@/lib/sms/conversation-house-access.server",async(original)=>({...await original<typeof import("@/lib/sms/conversation-house-access.server")>(),loadAssignableConversationHouses:mocks.access}));
import { GET,PATCH } from "@/app/api/manager/tour-follow-ups/route";
const id="00000000-0000-0000-0000-000000000001",key="owner:prospect:+12065550100",url=`https://example.test/api/manager/tour-follow-ups?conversationKey=${encodeURIComponent(key)}`;
const row={id,manager_user_id:"owner",status:"sent",send_at:"2026-09-13T15:00:00Z",payload:{propertyId:"house",conversationKey:key,customBody:"Still interested?"}};
let outbox:Record<string,unknown>|null;
function request(body:unknown){return new Request(url,{method:"PATCH",body:JSON.stringify(body)});}
beforeEach(()=>{
 vi.resetAllMocks();outbox={manager_user_id:"owner",dedupe_key:`tour-interest:${id}`,status:"queued",dispatch_started_at:null};
 mocks.auth.mockResolvedValue({user:{id:"viewer"},roles:["manager"]});
 mocks.fetch.mockResolvedValue({residents:[{conversationKey:key,memberKeys:[key],ownerManagerUserId:"owner"}]});
 mocks.access.mockResolvedValue({assignable:new Map([["house",{ownerUserId:"owner"}]]),workspaceHouses:new Map([["house",{ownerUserId:"owner"}]])});
 mocks.scope.mockResolvedValue({ownerIds:new Set(["owner"]),propertyIdsByOwner:new Map([["owner",new Set(["house"])]])});
 mocks.tags.mockResolvedValue([{conversation_key:key,property_id:"house"}]);
 mocks.rpc.mockImplementation(async(name)=>({data:name==="conversation_house_access_revision"?"revision":"ok",error:null}));
 mocks.from.mockImplementation((table)=>{
  const result={data:table==="portal_reminder_records"?[row]:outbox?[outbox]:[],error:null};
  const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,limit:()=>q,then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(result).then(resolve)};return q;
 });
});
it("returns actual queued delivery with separate edit and cancel affordances",async()=>{
 const response=await GET(new Request(url));expect(response.status).toBe(200);
 expect(await response.json()).toEqual({reminders:[{id,conversationKey:key,status:"queued",sendAt:row.send_at,body:"Still interested?",canEdit:false,canCancel:true}]});
 expect(mocks.fetch).not.toHaveBeenCalled();
});
it("does not offer cancellation after submission",async()=>{
 outbox={...outbox,status:"submitted",dispatch_started_at:"2026-09-13T15:00:00Z"};
 const body=await (await GET(new Request(url))).json();expect(body.reminders[0]).toMatchObject({status:"sending",canCancel:false});
});
it("filters rows without per-property read grants even when owner scope contains the workspace",async()=>{
 mocks.scope.mockResolvedValue({ownerIds:new Set(["owner"]),propertyIdsByOwner:new Map([["owner",new Set(["different-house"])]])});
 expect(await (await GET(new Request(url))).json()).toEqual({reminders:[]});
});
it("requires authentication even when there are no reminders",async()=>{
 mocks.auth.mockResolvedValue({user:null,roles:[]});expect((await GET(new Request(url))).status).toBe(401);expect(mocks.from).not.toHaveBeenCalled();
});
it("reports an already submitted text as a conflict without pretending it was cancelled",async()=>{
 mocks.rpc.mockImplementation(async(name)=>({data:name==="conversation_house_access_revision"?"revision":"started",error:null}));
 expect((await PATCH(request({conversationKey:key,id,action:"cancel"}))).status).toBe(409);
});
it("forwards fresh server authorization to atomic cancellation",async()=>{
 expect((await PATCH(request({conversationKey:key,id,action:"cancel"}))).status).toBe(200);
 expect(mocks.rpc).toHaveBeenCalledWith("change_tour_interest_followup",expect.objectContaining({p_owner:"owner",p_actor:"viewer",p_id:id,p_access_revision:"revision",p_allowed_properties:["house"]}));
});
it("authorizes the whole persisted thread before adding an archive barrier",async()=>{
 mocks.tags.mockResolvedValue([{conversation_key:key,property_id:"unauthorized"}]);
 expect((await PATCH(request({conversationKey:key,action:"archive"}))).status).toBe(403);
 expect(mocks.rpc).not.toHaveBeenCalledWith("change_tour_interest_followup",expect.anything());
});
it("requires an explicit reminder id to cancel instead of canceling all history",async()=>{
 expect((await PATCH(request({conversationKey:key,action:"cancel"}))).status).toBe(400);
});
it("turns a permission race rejected inside the transaction into 403",async()=>{
 mocks.rpc.mockImplementation(async(name)=>name==="conversation_house_access_revision"?{data:"revision",error:null}:{data:null,error:{code:"42501"}});
 expect((await PATCH(request({conversationKey:key,id,action:"cancel"}))).status).toBe(403);
});

function storedNotice(owner = "owner") {
  const notice = { id: "sms_notice_one", owner_user_id: owner, scope: "axis_portal_inbox_manager_v1", thread_type: "sms_relay", row_data: { smsNoticePhone: "+12065550100" } };
  mocks.from.mockImplementation(() => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: notice, error: null }) };
    return q;
  });
  mocks.fetch.mockResolvedValue({ residents: [
    { conversationKey: key, ownerManagerUserId: "owner", phone: "+12065550100" },
    { conversationKey: "other-owner", ownerManagerUserId: "other", phone: "+12065550100" },
    { conversationKey: "other-phone", ownerManagerUserId: "owner", phone: "+12065550101" },
  ] });
}
it("archives SMS notices using only stored owner and phone matches", async () => {
  storedNotice();
  expect((await PATCH(request({ inboxThreadId: "sms_notice_one", action: "archive" }))).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("change_tour_interest_followup", expect.objectContaining({ p_owner: "owner", p_keys: [key], p_action: "archive" }));
});
it("rejects a notice belonging to an unauthorized owner", async () => {
  storedNotice("stranger");
  expect((await PATCH(request({ inboxThreadId: "sms_notice_one", action: "archive" }))).status).toBe(404);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("retains property authorization for notice archives", async () => {
  storedNotice();
  mocks.tags.mockResolvedValue([{ conversation_key: key, property_id: "unauthorized" }]);
  expect((await PATCH(request({ inboxThreadId: "sms_notice_one", action: "archive" }))).status).toBe(403);
  expect(mocks.rpc).not.toHaveBeenCalledWith("change_tour_interest_followup", expect.anything());
});
