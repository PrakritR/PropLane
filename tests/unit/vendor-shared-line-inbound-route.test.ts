import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({validate:vi.fn(()=>true),proof:vi.fn(async()=>({handled:true,granted:true})),shared:vi.fn(),moved:vi.fn(),rpc:vi.fn(async()=>({data:true,error:null})),limit:vi.fn(async()=>({ok:true,unavailable:false}))}));
vi.mock("twilio",()=>({default:{validateRequest:mocks.validate}}));
vi.mock("@/lib/twilio-client.server",()=>({twilioWebhookAuthToken:()=>"auth",fetchTwilioMessageCreatedAt:async()=>"2026-11-04T12:00:00Z"}));
vi.mock("@/lib/vendor-quote-contact.server",()=>({processVendorQuoteSmsChallenge:mocks.proof}));
vi.mock("@/lib/protected-accounts.server",()=>({isShieldedRecipient:async()=>false}));
vi.mock("@/lib/supabase/service",()=>({createSupabaseServiceRoleClient:()=>({rpc:mocks.rpc})}));
vi.mock("@/lib/rate-limit",()=>({rateLimit:mocks.limit}));
vi.mock("@/lib/sms/resolve-owned-work-number.server",()=>({resolveOwnedWorkNumber:async()=>null}));
vi.mock("@/lib/one-number/config.server",async original=>({...await original<typeof import("@/lib/one-number/config.server")>(),loadSharedLineConfig:async()=>({mode:"shared",sharedNumber:"+12065550100",messagingServiceSid:"MGshared",pilotWorkspaceIds:[]})}));
vi.mock("@/lib/one-number/inbound-seam.server",()=>({handleSharedLineInbound:mocks.shared}));
vi.mock("@/lib/one-number/old-number.server",()=>({isOldNumberOnSharedLine:mocks.moved,sendMovedAutoReply:vi.fn()}));
vi.mock("@/lib/one-number/demo/store.server",()=>({endDemoForPhone:vi.fn()}));
vi.mock("@/lib/sms/inbound-pipeline.server",()=>({twimlOk:()=>new Response("<Response/>",{status:200}),inboundMediaParams:()=>({}),inboundRuntime:()=>"test",runClaimedInbound:vi.fn()}));
import { POST } from "@/app/api/twilio/inbound/route";
import { POST as legacyPost } from "@/app/api/webhooks/twilio/sms/route";
function request(body="QUOTE 123456789012",to="+12065550100",signed=true){return new Request("https://example.test/api/twilio/inbound",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",...(signed?{"x-twilio-signature":"signed"}:{})},body:new URLSearchParams({From:"+1 (317) 555-0123",To:to,Body:body,MessageSid:"SMproof",MessagingServiceSid:"MGshared"})});}
beforeEach(()=>{vi.clearAllMocks();mocks.validate.mockReturnValue(true);mocks.proof.mockResolvedValue({handled:true,granted:true});mocks.limit.mockResolvedValue({ok:true,unavailable:false});vi.stubEnv("NODE_ENV","test");vi.stubEnv("VERCEL","");});
describe("pre-router quote proof boundary",()=>{
 it("handles a signed unknown sender before shared routing",async()=>{expect((await POST(request())).status).toBe(200);expect(mocks.proof).toHaveBeenCalledWith(expect.anything(),{fromPhone:"+13175550123",toPhone:"+12065550100",body:"QUOTE 123456789012",messageSid:"SMproof",providerMessagingServiceSid:"MGshared"});expect(mocks.shared).not.toHaveBeenCalled();expect(mocks.moved).not.toHaveBeenCalled();});
 it("never rewrites an old-number proof destination",async()=>{expect((await POST(request("QUOTE 123456789012","+13175550999"))).status).toBe(200);expect(mocks.proof).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({toPhone:"+13175550999"}));expect(mocks.moved).not.toHaveBeenCalled();});
 it("rejects a forged signature",async()=>{mocks.validate.mockReturnValue(false);expect((await POST(request())).status).toBe(403);expect(mocks.proof).not.toHaveBeenCalled();});
 it("does not grant unsigned local-development proofs",async()=>{expect((await POST(request(undefined,undefined,false))).status).toBe(200);expect(mocks.proof).not.toHaveBeenCalled();});
 it("returns503 for a transient proof failure without an agent response",async()=>{mocks.proof.mockRejectedValueOnce(new Error("database unavailable"));expect((await POST(request())).status).toBe(503);expect(mocks.shared).not.toHaveBeenCalled();});
 it("keeps STOP and HELP ahead of ordinary proof rate limiting",async()=>{for(const keyword of ["STOP","HELP"]){expect((await POST(request(keyword))).status).toBe(200);}expect(mocks.rpc).toHaveBeenCalledTimes(2);expect(mocks.proof).not.toHaveBeenCalled();expect(mocks.limit).not.toHaveBeenCalled();});
});

describe("legacy webhook shares the signed proof boundary",()=>{
 it("classifies shared-line proofs before owned-number/session lookup",async()=>{expect((await legacyPost(request())).status).toBe(200);expect(mocks.proof).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({fromPhone:"+13175550123",toPhone:"+12065550100",providerMessagingServiceSid:"MGshared"}));});
 it("rejects a forged signature and returns503 for transient proof failure",async()=>{mocks.validate.mockReturnValue(false);expect((await legacyPost(request())).status).toBe(403);expect(mocks.proof).not.toHaveBeenCalled();mocks.validate.mockReturnValue(true);mocks.proof.mockRejectedValueOnce(new Error("database unavailable"));expect((await legacyPost(request())).status).toBe(503);});
 it("records HELP before rate limiting",async()=>{expect((await legacyPost(request("HELP"))).status).toBe(200);expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_control_keyword",expect.objectContaining({p_keyword:"HELP"}));expect(mocks.limit).not.toHaveBeenCalled();expect(mocks.proof).not.toHaveBeenCalled();});
});
