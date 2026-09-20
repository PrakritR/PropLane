import { describe, expect, it } from "vitest";
import { responseFor } from "@/lib/vendor-work-identity.server";
const identity = { id:"i",vendor_user_id:"v",lifecycle_state:"ready",email_state:"ready",sms_state:"ready",email_address:"v@x.test",email_provider_id:"d",email_send_ready:true,email_receive_ready:true,email_domain_verified:true,phone_number:"+12065550111",phone_number_sid:"PN",messaging_service_sid:"MG",carrier_ready:true,sms_send_ready:true,sms_receive_ready:true,attachment_state:"attached",quarantined_at:null,released_at:null } as never;
const runtime = { enabled:true,max_active_identities:4,outbound_message_cap:10 } as never;
describe("vendor identity effective readiness",()=>{
 it("keeps receive on runtime pause but disables send",()=>{const r=responseFor({identity,runtime:{...runtime,enabled:false},emailConfigured:true,smsConfigured:true,outboundUsed:0});expect(r.email).toMatchObject({sendReady:false,receiveReady:true});});
 it("cap disables only send",()=>{const r=responseFor({identity,runtime,emailConfigured:true,smsConfigured:true,outboundUsed:10});expect(r.sms).toMatchObject({sendReady:false,receiveReady:true});});
 it("provider and lifecycle gate receive",()=>{const r=responseFor({identity:{...identity,email_state:"released"},runtime,emailConfigured:false,smsConfigured:true,outboundUsed:0});expect(r.email).toMatchObject({sendReady:false,receiveReady:false,canSetup:false});});
});
