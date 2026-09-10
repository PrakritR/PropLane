import { afterEach, describe, expect, it, vi } from "vitest";
import { invoiceManagerCommsUsage } from "@/lib/comms-billing/stripe-invoicing.server";
const stripe=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/stripe",()=>({getStripe:stripe}));
afterEach(()=>vi.unstubAllEnvs());
describe("retired automatic communication invoices",()=>{
 it.each(["0","1",""])("never charges a saved card with billing flag %s",async(flag)=>{
  vi.stubEnv("COMMS_PAYG_BILLING_ENABLED",flag);const db={from:vi.fn()};
  expect(await invoiceManagerCommsUsage(db as never,"owner")).toEqual({ok:true,invoiced:false,reason:"prepaid_credit"});
  expect(db.from).not.toHaveBeenCalled();expect(stripe).not.toHaveBeenCalled();
 });
});
