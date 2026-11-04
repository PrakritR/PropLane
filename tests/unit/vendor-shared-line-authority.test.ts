import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
const boundary = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => boundary.db }));
vi.mock("@/lib/server-ttl-cache", async (original) => ({ ...await original<typeof import("@/lib/server-ttl-cache")>(), serverSnapshotCacheEnabled: () => true }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), cache: (fn: (...args: unknown[]) => unknown) => {
  const memo = new Map<string, unknown>();
  return (...args: unknown[]) => { const key = JSON.stringify(args); if (!memo.has(key)) memo.set(key, fn(...args)); return memo.get(key); };
} }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: async () => ({ allowed: false, reason: "allowance_exhausted" }) }));
vi.mock("@/lib/vendor-quote-agent.server", () => ({ runVendorQuoteQuestionTurn: vi.fn() }));
import { resolveVendorOutreachIdentity } from "@/lib/vendor-outreach-identity.server";
import { resolveVendorQuoteSenderProof } from "@/lib/vendor-quote-sender-proof.server";
import { processVendorQuoteSmsChallenge } from "@/lib/vendor-quote-contact.server";
import { resolveWorkspaceSenderTransport, evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { readPromoCodePolicies, clearPromoCodePolicyCache } from "@/lib/promo-code-policy.server";
import type { SenderPolicyReadContext } from "@/lib/one-number/sender-policy-read.server";
const OWNER = "11111111-1111-4111-8111-111111111111", PLATFORM = "22222222-2222-4222-8222-222222222222";
const WS = "44444444-4444-4444-8444-444444444444", NOW = Date.parse("2026-11-04T12:00:00Z");
type Row = Record<string, unknown>;
function database() {
  const rows: Record<string, Row[]> = {
    sms_runtime_config: [{ singleton: true, mode: "automatic", line_mode: "shared", shared_number_e164: "+12065550100", shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [] }],
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, is_default: true, is_service: false, name: "Workspace" }],
    profiles: [{ id: OWNER, full_name: "Manager" }],
    portal_work_order_records: [{ id: "service", property_id: "property", manager_user_id: OWNER }],
    manager_property_records: [{ id: "property", workspace_id: WS, manager_user_id: OWNER }],
    manager_assistant_emails: [{ manager_user_id: OWNER, workspace_id: WS, provision_state: "active", inbox_token: "abcdefgh", mailbox_local: "work" }],
    manager_sms_numbers: [], workspace_work_numbers: [], manager_purchases: [], number_subscriptions: [], manager_promo_code_policies: [],
    vendor_quote_contact_capabilities: [], vendor_quote_sms_consent_challenges: [],
  };
  const failures = new Set<string>(), operations: string[] = [];
  const authEmail = new Map<string, string>();
  const authRead = vi.fn(async (id: string) => ({ data: { user: { id, email: authEmail.get(id), email_confirmed_at: authEmail.has(id) ? "2026-01-01" : null } }, error: null }));
  const rpc = vi.fn(async (name: string) => name === "read_vendor_quote_sender_authority_revision"
    ? { data: [{ revision: "1", evaluated_at: new Date(NOW).toISOString() }], error: null } : { data: true, error: null });
  const db = { auth: { admin: { getUserById: authRead } }, rpc, from(table: string) {
    operations.push(table);
    const predicates: ((row: Row) => boolean)[] = [];
    let limit = Infinity;
    const execute = () => failures.has(table) ? { data: null, error: { code: "42P01", message: "read failed" } } : { data: (rows[table] ?? []).filter(row => predicates.every(p => p(row))).slice(0, limit), error: null };
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => { predicates.push(r => r[key] === value); return q; },
      is: (key: string, value: unknown) => { predicates.push(r => (r[key] ?? null) === value); return q; },
      in: (key: string, values: unknown[]) => { predicates.push(r => values.includes(r[key])); return q; },
      not: (key: string, _op: string, value: unknown) => { predicates.push(r => (r[key] ?? null) !== value); return q; },
      ilike: (key: string, value: string) => { predicates.push(r => String(r[key] ?? "").toLowerCase() === value.toLowerCase()); return q; },
      or: (value: string) => { const id = value.split("user_id.eq.")[1]; predicates.push(r => r.user_id == null || r.user_id === id); return q; },
      gt: (key: string, value: string) => { predicates.push(r => Date.parse(String(r[key])) > Date.parse(value)); return q; },
      order: () => q,
      limit: (n: number) => { limit = n; return q; },
      maybeSingle: async () => { const result = execute(); return { ...result, data: result.data?.[0] ?? null }; },
      then: (resolve: (value: unknown) => void) => resolve(execute()),
    };
    return q;
  } };
  const client = db as unknown as SupabaseClient;
  boundary.db = client;
  const context = (): SenderPolicyReadContext => ({ db: client, nowMs: NOW, validUntilMs: NOW + 5000, workspaceId: WS });
  const number = (over: Row = {}) => ({ id: "number", manager_user_id: OWNER, workspace_id: WS, phone_number: "+13175550999", phone_number_sid: "PN1", campaign_sid: "CP1", messaging_service_sid: "MGqa", provision_state: "active", registration_state: "approved", registration_ref: "reg", released_at: null, provisioned_at: "2026-11-01", ...over });
  const plan = (over: Row = {}) => ({ id: "purchase", user_id: OWNER, tier: "pro", billing: "monthly", paid_at: "2026-11-01", stripe_subscription_id: "sub_paid", ...over });
  return { db: client, rows, failures, rpc, context, number, plan, operations, authRead, authEmail };
}
beforeEach(() => {
  clearPromoCodePolicyCache();
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGqa"); vi.stubEnv("TWILIO_CAMPAIGN_SID", "CP1");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "proof-test-secret"); vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "example.test");
});
describe("fresh canonical sender selection", () => {
  it("selects shared without a number row, preserves workspace and separate provider scope", async () => {
    const f = database();
    const identity = await resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context());
    expect(identity).toMatchObject({ workspaceId: WS, workPhone: "+12065550100", messagingServiceSid: "MGqa", providerMessagingServiceSid: "MGshared", selectedLineId: null, transportKind: "shared" });
    expect(f.authRead).not.toHaveBeenCalled();
  });
  it.each(["paid", "converted", "addon", "grandfathered", "waived", "comped", "suspended"])("uses the same number entitlement for %s", async mode => {
    const f = database();f.rows.manager_sms_numbers.push(f.number());
    if (mode === "paid" || mode === "converted") f.rows.manager_purchases.push(f.plan({ billing: mode === "converted" ? "trial" : "monthly" }));
    if (mode === "addon") { f.rows.manager_purchases.push(f.plan({ tier: "free", stripe_subscription_id: null })); f.rows.number_subscriptions.push({ owner_user_id: OWNER, status: "active" }); }
    if (["grandfathered", "waived", "comped"].includes(mode)) f.rows.manager_purchases.push(f.plan({ stripe_subscription_id: null, promo_code: mode === "comped" ? null : "FREE100", billing: mode === "comped" ? "admin" : "monthly" }));
    if (mode === "grandfathered") f.rows.manager_sms_numbers[0].provisioned_at = "2026-10-01";
    if (mode === "suspended") f.rows.number_subscriptions.push({ owner_user_id: OWNER, status: "canceled" });
    const identity = await resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context());
    expect(identity?.workPhone).toBe(["paid", "converted", "addon", "grandfathered"].includes(mode) ? "+13175550999" : "+12065550100");
  });
  it("resolves linked paid work lines without evaluating unrelated platform owners", async () => {
    const f = database(); f.rows.manager_sms_numbers.push(f.number({ workspace_id: "other" }));
    f.rows.workspace_work_numbers.push({ workspace_id: WS, number_id: "number", is_primary: true }); f.rows.manager_purchases.push(f.plan());
    for (let i = 0; i < 1100; i++) f.rows.manager_sms_numbers.push(f.number({ id: `irrelevant-${i}`, workspace_id: `unrelated-${i}`, manager_user_id: `unrelated-owner-${i}` }));
    expect((await resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context()))?.workPhone).toBe("+13175550999");
    expect(f.authRead.mock.calls.every(([id]) => id === OWNER)).toBe(true);
  });
  it.each(["shared", "per_workspace"])("managed workspaces override old personal lines in %s mode", async mode => {
    const f = database(); f.rows.portal_workspaces[0].is_service = true; f.rows.sms_runtime_config[0].line_mode = mode;
    f.rows.manager_sms_numbers.push(f.number());
    f.rows.portal_workspaces.push({ id: "platform", owner_user_id: PLATFORM, is_default: true, is_service: false });
    f.rows.platform_service_settings = [{ singleton: true, owner_user_id: PLATFORM }];
    f.rows.manager_sms_numbers.push(f.number({ id: "platform-line", manager_user_id: PLATFORM, workspace_id: "platform", phone_number: "+12065550100" }));
    const identity = await resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context());
    expect(identity?.workPhone).toBe("+12065550100");expect(identity?.selectedLineId).toBe(mode === "shared" ? null : "platform-line");
  });
  it("a paused runtime preserves legal identity while delivery is refused", async () => {
    const f = database(); f.rows.sms_runtime_config[0].mode = "paused";
    expect(await resolveWorkspaceSenderTransport({ db: f.db, ownerUserId: OWNER, workspaceId: WS, requiredCents: 0, policyRead: f.context() })).toMatchObject({ canSend: true, viaSharedLine: true });
    expect(await evaluateWorkspaceSendReadiness({ db: f.db, ownerUserId: OWNER, workspaceId: WS, requiredCents: 1, policyRead: f.context() })).toEqual({ canSend: false, reason: "runtime_paused" });
  });
  it("a zero wallet preserves the legal sender and blocks challenge delivery readiness", async () => {
    const f=database();
    expect((await resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context()))?.workPhone).toBe("+12065550100");
    expect(await evaluateWorkspaceSendReadiness({db:f.db,ownerUserId:OWNER,workspaceId:WS,requiredCents:1,policyRead:f.context()})).toEqual({canSend:false,reason:"comms_billing_allowance_exhausted"});
  });
  it("refuses an absent strict runtime row and bounded candidate-row overflow", async () => {
    const f=database();f.rows.sms_runtime_config=[];
    await expect(resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context())).rejects.toThrow(/unreadable/);
    const overflow=database();for(let i=0;i<201;i++)overflow.rows.manager_sms_numbers.push(overflow.number({id:`overflow-${i}`}));
    await expect(resolveVendorOutreachIdentity(overflow.db,OWNER,"service","email",overflow.context())).rejects.toThrow(/unreadable/);
  });
  it.each(["sms_runtime_config", "workspace_work_numbers", "manager_purchases", "manager_assistant_emails"])("refuses unreadable %s without a permissive fallback", async table => {
    const f = database(); f.rows.manager_sms_numbers.push(f.number());f.rows.manager_purchases.push(f.plan());f.failures.add(table);
    await expect(resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context())).rejects.toThrow(/unreadable/);
  });
  it("does not rename a legacy mailbox or provision a workspace during evaluation", async () => {
    const f = database();f.rows.manager_assistant_emails[0].mailbox_local = null;
    expect((await resolveVendorOutreachIdentity(f.db, OWNER, "service", "email", f.context()))?.email).toBe("assistant+abcdefgh@example.test");
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("fresh reads bypass prewarmed React and promo TTL caches and expose waiver boundary", async () => {
    const f = database(); const id = "33333333-3333-4333-8333-333333333333";
    f.rows.manager_purchases.push(f.plan({ user_id: id, stripe_subscription_id: null, promo_code: "FREE100" }));
    f.rows.manager_promo_code_policies.push({ code: "FREE100", expires_at: null });
    expect(await getEffectiveManagerSkuTier(id)).toMatchObject({ tier: "pro" }); await readPromoCodePolicies(f.db);
    f.rows.manager_promo_code_policies[0].expires_at = new Date(NOW + 1000).toISOString();
    const context = f.context(); expect(await getEffectiveManagerSkuTier(id, context)).toMatchObject({ tier: "pro" }); expect(context.validUntilMs).toBe(NOW + 1000);
    f.rows.manager_promo_code_policies[0].expires_at = new Date(NOW - 1).toISOString();
    expect(await getEffectiveManagerSkuTier(id)).toMatchObject({ tier: "pro" });
    expect(await getEffectiveManagerSkuTier(id, f.context())).toMatchObject({ tier: "free" });
  });
  it("re-evaluates confirmed Auth email ownership instead of a prewarmed purchase view", async () => {
    const f=database();f.rows.manager_sms_numbers.push(f.number());
    f.rows.manager_purchases.push(f.plan({user_id:null,email:"confirmed@example.test"}));f.authEmail.set(OWNER,"confirmed@example.test");
    expect((await resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context()))?.workPhone).toBe("+13175550999");
    f.authEmail.set(OWNER,"changed@example.test");
    expect((await resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context()))?.workPhone).toBe("+12065550100");
  });
  it("rejects an active email row whose owner differs from the persisted workspace owner", async () => {
    const f=database();f.rows.manager_assistant_emails[0].manager_user_id=PLATFORM;
    await expect(resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context())).rejects.toThrow(/owner mismatch/);
  });
  it("uses canonical normalization for stored promo policy keys",async()=>{
    const f=database();f.rows.manager_purchases.push(f.plan({stripe_subscription_id:null,promo_code:"FREE100"}));
    f.rows.manager_promo_code_policies.push({code:"free-100",expires_at:new Date(NOW-1).toISOString()});
    expect(await getEffectiveManagerSkuTier(OWNER,f.context())).toMatchObject({tier:"free"});
  });
  it("caps proof validity at the canonical signup trial end", async () => {
    const f = database(); f.rows.manager_sms_numbers.push(f.number());
    f.rows.manager_purchases.push(f.plan({ stripe_subscription_id: null, billing: "trial", paid_at: new Date(NOW + 2000 - 14 * 86400000).toISOString() }));
    const context=f.context();await resolveVendorOutreachIdentity(f.db,OWNER,"service","email",context);expect(context.validUntilMs).toBe(NOW+2000);
  });
  it("honors assigned property before the legacy property's workspace", async () => {
    const f=database();f.rows.portal_work_order_records[0].assigned_property_id="assigned";
    f.rows.manager_property_records.push({id:"assigned",workspace_id:"missing",manager_user_id:OWNER});
    await expect(resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context())).rejects.toThrow(/workspace authority unreadable/);
  });
});

async function challengeFixture() {
  const f=database();
  const sender=await resolveVendorOutreachIdentity(f.db,OWNER,"service","email",f.context());
  const cap={id:"cap",manager_user_id:OWNER,work_order_id:"service",sender_mode:"software",sender_version:1,sender_snapshot:sender,expires_at:"2099-01-01"};
  f.rows.vendor_quote_contact_capabilities.push(cap);
  const code="123456789012",phone="+13175550123";
  const challenge={id:"challenge",capability_id:"cap",requested_phone:phone,work_phone:"+12065550100",messaging_service_sid:"MGqa",expires_at:"2099-01-01",code_digest:createHmac("sha256","proof-test-secret").update(`cap:${phone}:${code}`).digest("hex")};
  f.rows.vendor_quote_sms_consent_challenges.push(challenge);
  const input={fromPhone:phone,toPhone:"+12065550100",body:`QUOTE ${code}`,messageSid:"SMproof",providerMessagingServiceSid:"MGshared"};
  return {...f,cap,challenge,input};
}
describe("signed wire-pair proof classification",()=>{
  it("consumes an unknown phone on the shared number without an owned-number lookup",async()=>{
    const f=await challengeFixture();
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:true});
    expect(f.rpc).toHaveBeenCalledWith("consume_vendor_quote_sms_challenge",expect.objectContaining({p_challenge_id:"challenge",p_to_phone:f.input.toPhone,p_sender_proof:expect.objectContaining({channel:"sms",senderSnapshot:expect.objectContaining({transportKind:"shared",workspaceId:WS})})}));
  });
  it("finds the unique HMAC when the same phone has challenges for multiple workspaces",async()=>{
    const f=await challengeFixture();f.rows.vendor_quote_sms_consent_challenges.unshift({...f.challenge,id:"other",capability_id:"othercap",code_digest:"a".repeat(64)});
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:true});
  });
  it.each(["from","to","code","provider"])("refuses a wrong %s without consent writes",async kind=>{
    const f=await challengeFixture();
    const input={...f.input,...(kind==="from"?{fromPhone:"+13175550124"}:kind==="to"?{toPhone:"+12065550101"}:kind==="code"?{body:"QUOTE 123456789013"}:{providerMessagingServiceSid:"MGwrong"})};
    expect(await processVendorQuoteSmsChallenge(f.db,input)).toEqual({handled:true,granted:false});
    expect(f.rpc.mock.calls.every(([name])=>name!=="consume_vendor_quote_sms_challenge")).toBe(true);
  });
  it.each(["collision","overflow"])("fails closed on %s",async mode=>{
    const f=await challengeFixture();const count=mode==="collision"?1:32;
    for(let i=0;i<count;i++)f.rows.vendor_quote_sms_consent_challenges.push({...f.challenge,id:`duplicate-${i}`});
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:false});expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects revoked and expired challenges and does not recognize relaxed grammar",async()=>{
    const f=await challengeFixture();f.rows.vendor_quote_sms_consent_challenges[0].revoked_at="2026-01-01";
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:false});
    f.rows.vendor_quote_sms_consent_challenges[0].revoked_at=null;f.rows.vendor_quote_sms_consent_challenges[0].expires_at="2000-01-01";
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:false});
    expect(await processVendorQuoteSmsChallenge(f.db,{...f.input,body:"QUOTE  123456789012"})).toEqual({handled:false,granted:false});
  });
  it("replays a successful MessageSid and refuses a different event",async()=>{
    const f=await challengeFixture();Object.assign(f.rows.vendor_quote_sms_consent_challenges[0],{consumed_at:"2026-01-01",inbound_event_id:f.input.messageSid});
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:true});
    expect(await processVendorQuoteSmsChallenge(f.db,{...f.input,messageSid:"SMother"})).toEqual({handled:true,granted:false});expect(f.rpc).not.toHaveBeenCalled();
  });
  it("surfaces database failures for webhook retry",async()=>{
    const f=await challengeFixture();f.failures.add("vendor_quote_sms_consent_challenges");
    await expect(processVendorQuoteSmsChallenge(f.db,f.input)).rejects.toThrow(/unavailable/);
  });
  it("retries a revision mismatch once with a new fresh proof",async()=>{
    const f=await challengeFixture();let consumes=0;
    const original=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async name=>name==="consume_vendor_quote_sms_challenge" && consumes++===0
      ? {data:null,error:{message:"sender authority changed"}} as never : original(name));
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:true});
    expect(f.rpc.mock.calls.filter(([name])=>name==="read_vendor_quote_sender_authority_revision")).toHaveLength(2);
    expect(f.rpc.mock.calls.filter(([name])=>name==="consume_vendor_quote_sms_challenge")).toHaveLength(2);
  });
  it("refuses a changed canonical sender before presenting a proof",async()=>{
    const f=await challengeFixture();f.rows.sms_runtime_config[0].shared_number_e164="+12065550101";
    expect(await resolveVendorQuoteSenderProof(f.db,f.cap,"sms")).toBeNull();
    expect(await processVendorQuoteSmsChallenge(f.db,f.input)).toEqual({handled:true,granted:false});
  });
});
