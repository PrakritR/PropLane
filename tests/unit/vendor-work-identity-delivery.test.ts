import { beforeEach, describe, expect, it, vi } from "vitest";
const suppression = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: suppression }));
import { deliverVendorWorkIdentity } from "@/lib/vendor-work-identity-delivery.server";

const provider = { configured: vi.fn().mockReturnValue(true), email: vi.fn().mockResolvedValue({ id: "email-1" }), sms: vi.fn().mockResolvedValue({ id: "sms-1" }) };
function db(opts: { ready?: boolean; claimed?: boolean; cap?: boolean } = {}) {
  const writes: unknown[] = [];
  const from = vi.fn((table: string) => { const q: Record<string, unknown> = {}; q.select=()=>q; q.eq=()=>q; q.insert=(v:unknown)=>{writes.push({table,v});return q}; q.update=(v:unknown)=>{writes.push({table,v});return q}; q.maybeSingle=async()=>({data:table==="vendor_work_identity_runtime"?{enabled:true}:table==="vendor_work_identity_delivery_attempts"?{id:"attempt"}:opts.ready===false?null:{id:"i",email_address:"vendor@prop.test",phone_number:"+12065550111",email_state:"ready",sms_state:"ready",email_send_ready:true,sms_send_ready:true,email_domain_verified:true},error:null}); q.then=(r:(v:unknown)=>unknown)=>r({error:null}); return q; });
  const rpc = vi.fn((name:string) => Promise.resolve(name.includes("operation") ? {data:{operation_id:"op",claimed:opts.claimed??true},error:null} : opts.cap ? {data:{outbox_id:null,blocked_reason:"platform_cap_reached"},error:null} : {data:{outbox_id:"out",claimed:opts.claimed??true},error:null}));
  return { db:{from,rpc} as never,writes };
}
const base={vendorUserId:"v",channel:"email" as const,recipient:"r@test.com",subject:"Hi",text:"Body",idempotencyKey:"k"};
beforeEach(()=>{vi.clearAllMocks(); suppression.mockResolvedValue({ok:true,optedOut:false});});
describe("vendor sponsored delivery",()=>{
 it("blocks unconfigured provider without send",async()=>{provider.configured.mockReturnValueOnce(false);const x=db();expect((await deliverVendorWorkIdentity(x.db,base,provider)).reason).toBe("provider_unconfigured");expect(provider.email).not.toHaveBeenCalled();});
 it("uses exact ready email From and persists accepted id",async()=>{const x=db();await deliverVendorWorkIdentity(x.db,base,provider);expect(provider.email).toHaveBeenCalledWith(expect.objectContaining({from:"vendor@prop.test"}));expect(x.writes).toContainEqual(expect.objectContaining({table:"vendor_work_identity_outbox"}));});
 it("keeps SMS independent and suppresses before provider",async()=>{suppression.mockResolvedValue({ok:true,optedOut:true});const x=db();const r=await deliverVendorWorkIdentity(x.db,{...base,channel:"sms",recipient:"+12065550000"},provider);expect(r.reason).toBe("recipient_opted_out");expect(provider.sms).not.toHaveBeenCalled();});
 it("does not replay claimed delivery",async()=>{const x=db({claimed:false});const r=await deliverVendorWorkIdentity(x.db,base,provider);expect(r.sent).toBe(false);expect(provider.email).not.toHaveBeenCalled();});
 it("quarantines ambiguous provider failure",async()=>{provider.email.mockRejectedValueOnce(new Error("network timeout"));const x=db();expect((await deliverVendorWorkIdentity(x.db,base,provider)).reason).toBe("provider_outcome_unknown");expect(x.writes).toContainEqual(expect.objectContaining({table:"vendor_work_identity_outbox",v:expect.objectContaining({status:"reconciling"})}));});
});
