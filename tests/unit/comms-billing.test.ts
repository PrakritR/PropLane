import { beforeEach, describe, expect, it, vi } from "vitest";
const plan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-access-server", () => ({getEffectiveManagerSkuTier:plan}));
vi.mock("@/lib/comms-billing/notifications.server", () => ({maybeNotifyCommsBudgetThreshold:vi.fn(async()=>undefined)}));
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import { reserveCommsCredit, loadCommsWallet, loadCommsWalletTotals } from "@/lib/comms-billing/wallet.server";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";
const snapshot = {allowance_cents:200,included_remaining_cents:200,purchased_remaining_cents:0,next_allowance_cents:200,period_start:"2026-09-01T00:00:00Z",period_end:"2026-10-01T00:00:00Z",paused:false};
beforeEach(()=>{vi.unstubAllEnvs();plan.mockResolvedValue({ok:true,tier:"free"});});
function database(data: unknown = snapshot) {return {rpc:vi.fn().mockResolvedValue({data,error:null})};}
describe("prepaid communication boundary",()=>{
 it("verifies the exact required amount and never uses saved-card eligibility",async()=>{
  const db=database({...snapshot,included_remaining_cents:2});
  expect(await evaluateManagerCommsBillingGate(db as never,"owner",3)).toMatchObject({allowed:false,reason:"allowance_exhausted"});
  expect(await evaluateManagerCommsBillingGate(db as never,"owner",2)).toMatchObject({allowed:true});
 });
 it("enforces the wallet even when old billing and limit flags are off",async()=>{
  vi.stubEnv("COMMS_PAYG_BILLING_ENABLED","0");vi.stubEnv("COMMS_LIMITS_ENFORCED","0");
  expect(await evaluateManagerCommsBillingGate(database({...snapshot,included_remaining_cents:0}) as never,"owner")).toMatchObject({allowed:false});
 });
 it("can use purchased credit after included credit is exhausted",async()=>{
  expect(await evaluateManagerCommsBillingGate(database({...snapshot,included_remaining_cents:0,purchased_remaining_cents:500}) as never,"owner",3)).toMatchObject({allowed:true});
 });
 it("fails closed on a paused account, unreadable plan, or database error",async()=>{
  expect(await evaluateManagerCommsBillingGate(database({...snapshot,paused:true}) as never,"owner")).toMatchObject({allowed:false,reason:"billing_paused"});
  plan.mockResolvedValue({ok:false,error:"offline"});const db=database();
  expect(await evaluateManagerCommsBillingGate(db as never,"owner")).toMatchObject({allowed:false,reason:"plan_unreadable"});expect(db.rpc).not.toHaveBeenCalled();
 });
 it("GET explicitly requests a read-only snapshot",async()=>{
  const db=database();await loadCommsWallet(db as never,"owner");
  expect(db.rpc).toHaveBeenCalledWith("comms_wallet_snapshot",{p_owner:"owner",p_allowance:200,p_legacy_allowance:250,p_apply:false});
 });
 it("staff bulk totals read every owner in one read-only round trip and omit unreadable wallets",async()=>{
  const db={rpc:vi.fn().mockResolvedValue({data:[
   {manager_user_id:"biz",snapshot:{...snapshot,allowance_cents:15000,included_remaining_cents:13000,purchased_remaining_cents:2500}},
   {manager_user_id:"broken",snapshot:null},
  ],error:null})};
  const totals=await loadCommsWalletTotals(db as never,[{managerUserId:"biz",tier:"business"},{managerUserId:"broken",tier:"free"}]);
  expect(db.rpc).toHaveBeenCalledTimes(1);
  expect(db.rpc).toHaveBeenCalledWith("comms_wallet_snapshots",{p_requests:[
   {owner:"biz",allowance:10000,legacy_allowance:15000},
   {owner:"broken",allowance:200,legacy_allowance:250},
  ]});
  expect(totals.get("biz")).toEqual({allowanceCents:15000,includedRemainingCents:13000,purchasedRemainingCents:2500,paused:false});
  expect(totals.has("broken")).toBe(false);
 });
 it("reserves server-priced SMS segments atomically",async()=>{
  const db=database({allowed:true,duplicate:false,state:"reserved"});
  await reserveCommsCredit(db as never,{managerUserId:"owner",meter:"sms_outbound_segment",quantity:3,idempotencyKey:"message-1"});
  expect(db.rpc).toHaveBeenCalledWith("reserve_comms_credit",expect.objectContaining({p_owner:"owner",p_quantity:3,p_unit_cents:3,p_allow_unfunded:false}));
 });
 it("records unavoidable incoming SMS without demanding unfunded outgoing credit",async()=>{
  const db=database({allowed:true,duplicate:false,state:"settled"});
  await recordManagerCommsUsage(db as never,{managerUserId:"owner",meter:"sms_inbound_segment",idempotencyKey:"inbound-1"});
  expect(db.rpc).toHaveBeenCalledWith("reserve_comms_credit",expect.objectContaining({p_unit_cents:2,p_allow_unfunded:true}));
 });
 it.each([0,-1,NaN,Infinity])("rejects invalid usage quantity %s",async(quantity)=>{
  const db=database();await expect(reserveCommsCredit(db as never,{managerUserId:"owner",meter:"sms_outbound_segment",quantity,idempotencyKey:"m"})).rejects.toThrow("Invalid communication");expect(db.rpc).not.toHaveBeenCalled();
 });
});
