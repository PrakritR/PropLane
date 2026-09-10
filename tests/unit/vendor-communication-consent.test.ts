import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({suppression:vi.fn(),read:vi.fn(),record:vi.fn()}));
vi.mock("@/lib/sms-consent",()=>({readSmsSuppressionState:mocks.suppression,readScopedSmsConsentState:mocks.read,recordScopedSmsConsent:mocks.record}));
import { ensureVendorConversationConsent } from "@/lib/sms/vendor-conversation-consent.server";
const input={managerUserId:"owner",vendorUserId:"vendor",phone:"+12065550123",sessionId:"session",evidence:{inboundMessageSid:"SMverified"}};
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID","MGconfigured");mocks.suppression.mockResolvedValue({ok:true,optedOut:false});mocks.read.mockResolvedValue({ok:true,state:"none"});mocks.record.mockResolvedValue({ok:true});});
describe("vendor work-number consent",()=>{
 it("records verified incoming evidence in exactly the dispatch scope",async()=>{const db={} as never;const result=await ensureVendorConversationConsent(db,input);expect(result.allowed).toBe(true);expect(mocks.record).toHaveBeenCalledWith(db,input.phone,expect.objectContaining({managerUserId:"owner",purpose:"vendor_conversation",conversationKey:result.conversationKey,sendClass:"transactional",messagingServiceSid:"MGconfigured",source:"verified_vendor_inbound",evidence:{sessionId:"session",inboundMessageSid:"SMverified"}}));});
 it.each(["revoked","granted"])("preserves existing %s consent without writing",async(state)=>{mocks.read.mockResolvedValue({ok:true,state});expect((await ensureVendorConversationConsent({} as never,input)).allowed).toBe(state==="granted");expect(mocks.record).not.toHaveBeenCalled();});
 it("does not replace STOP with a reply grant",async()=>{mocks.suppression.mockResolvedValue({ok:true,optedOut:true});expect((await ensureVendorConversationConsent({} as never,input)).allowed).toBe(false);expect(mocks.record).not.toHaveBeenCalled();});
 it("does not send when consent persistence fails",async()=>{mocks.record.mockResolvedValue({ok:false});await expect(ensureVendorConversationConsent({} as never,input)).rejects.toThrow("could not be saved");});
});
