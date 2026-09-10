// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const native=vi.hoisted(()=>({value:false}));
vi.mock("@/hooks/use-is-native-app",()=>({useIsNativeApp:()=>({isNative:native.value})}));
vi.mock("@/components/ui/modal",()=>({Modal:({open,children,title}:{open:boolean;children:ReactNode;title:string})=>open?<div role="dialog" aria-label={title}>{children}</div>:null}));
vi.mock("@/components/stripe/embedded-checkout",()=>({EmbeddedCheckoutMount:()=> <div>Verified Stripe checkout</div>}));
import { ManagerCommsBillingPanel } from "@/components/portal/manager-comms-billing-panel";
const summary={wallet:{tier:"free",allowanceCents:200,includedRemainingCents:0,purchasedRemainingCents:0,remainingCents:0,nextAllowanceCents:200},paygEnabled:true,billingPaused:false,blockMessage:"Buy more credit to continue.",periodEnd:"2026-10-01T00:00:00Z",monthToDateCents:200,monthlyBudgetCents:null,ratesCents:{sms_outbound_segment:3},meterTotals:[],purchases:[]};
beforeEach(()=>{native.value=false;window.history.replaceState({},"","/");vi.stubGlobal("fetch",vi.fn(async()=>Response.json(summary)));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("communication credit purchase states",()=>{
 it("keeps manual top-ups available at zero credit",async()=>{render(<ManagerCommsBillingPanel/>);const buy=await screen.findByRole("button",{name:"Buy more usage"});expect((buy as HTMLButtonElement).disabled).toBe(false);fireEvent.click(buy);expect(await screen.findByRole("dialog",{name:"Buy more usage"})).toBeTruthy();expect(screen.getAllByText(/No automatic recharge/).length).toBeGreaterThan(0);});
 it("does not present purchases on an unreadable balance",async()=>{vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:"Unavailable"},{status:503})));render(<ManagerCommsBillingPanel/>);expect(await screen.findByRole("alert")).toBeTruthy();expect(screen.queryByRole("button",{name:"Buy more usage"})).toBeNull();expect(screen.getByRole("button",{name:"Try again"})).toBeTruthy();});
 it("does not let a redirect grant credit before verified fulfillment",async()=>{window.history.replaceState({},"","/?comms_purchase=pending");render(<ManagerCommsBillingPanel/>);expect(await screen.findByText(/Payment confirmation is pending/)).toBeTruthy();expect(screen.queryByText(/credit added/)).toBeNull();});
 it("keeps shared credit visible on native without a Stripe purchase link",async()=>{native.value=true;render(<ManagerCommsBillingPanel/>);expect(await screen.findByText("Additional credit purchases are not available in this app yet.")).toBeTruthy();expect(screen.queryByRole("button",{name:"Buy more usage"})).toBeNull();expect(screen.queryByRole("link",{name:/buy|purchase/i})).toBeNull();});
});
