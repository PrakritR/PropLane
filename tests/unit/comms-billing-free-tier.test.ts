import { beforeEach, describe, expect, it, vi } from "vitest";
const plan=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/manager-access-server",()=>({getEffectiveManagerSkuTier:plan,getManagerPurchaseSku:vi.fn()}));
import { getEffectiveManagerSmsEntitlement,reconcileManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
beforeEach(()=>vi.clearAllMocks());
describe("work numbers on every plan",()=>{
 it.each(["free","pro","business",null])("includes number access for effective tier %s",async(tier)=>{
  plan.mockResolvedValue({ok:true,tier});const db={from:vi.fn()};
  expect(await getEffectiveManagerSmsEntitlement(db as never,"owner")).toEqual({eligible:true,tier:tier??"free",source:"none"});
  expect(await reconcileManagerSmsEntitlement(db as never,"owner")).toMatchObject({eligible:true});
  expect(db.from).not.toHaveBeenCalled();
 });
 it("does not grant access when the plan cannot be read",async()=>{
  plan.mockResolvedValue({ok:false,error:"offline"});
  expect(await getEffectiveManagerSmsEntitlement({} as never,"owner")).toEqual({eligible:false,reason:"plan_unreadable"});
 });
});
