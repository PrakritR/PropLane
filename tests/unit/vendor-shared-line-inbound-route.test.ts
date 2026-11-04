import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  validate: vi.fn(), owned: vi.fn(), vendorSession: vi.fn(), proof: vi.fn(), reconcile: vi.fn(), shared: vi.fn(), moved: vi.fn(), rpc: vi.fn(), limit: vi.fn(), after: vi.fn(),
  db: null as unknown,
}));
vi.mock("twilio", () => ({ default: { validateRequest: mocks.validate } }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "auth", fetchTwilioMessageCreatedAt: async () => "2026-11-04T12:00:00Z" }));
vi.mock("@/lib/vendor-quote-contact.server", () => ({ processVendorQuoteSmsChallenge: mocks.proof, reconcileVendorQuoteSmsOutcome: mocks.reconcile }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limit }));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: mocks.owned }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ resolveVendorAgentSessionForInbound: mocks.vendorSession, runVendorAgentSessionTurn: vi.fn(), vendorSessionIdsOnLine: vi.fn() }));
vi.mock("@/lib/one-number/config.server", async original => ({
  ...await original<typeof import("@/lib/one-number/config.server")>(),
  loadSharedLineConfig: async () => ({ mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] }),
  loadSharedLineConfigStrict: async () => ({ ok: true, config: { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] } }),
}));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ handleSharedLineInbound: mocks.shared }));
vi.mock("@/lib/one-number/old-number.server", () => ({ isOldNumberOnSharedLine: mocks.moved, sendMovedAutoReply: vi.fn() }));
vi.mock("@/lib/one-number/demo/store.server", () => ({ endDemoForPhone: vi.fn(async () => undefined) }));
vi.mock("@/lib/sms/inbound-pipeline.server", () => ({ twimlOk: () => new Response("<Response/>", { status: 200 }), inboundMediaParams: () => ({}), inboundRuntime: () => "development", runClaimedInbound: vi.fn() }));
import { MemoryDb } from "../helpers/sms-envelope-memory-db";
import { POST } from "@/app/api/twilio/inbound/route";
import { POST as legacyPost } from "@/app/api/webhooks/twilio/sms/route";
const SID = `SM${"1".repeat(32)}`, ACCOUNT = `AC${"2".repeat(32)}`, SERVICE = `MG${"3".repeat(32)}`;
let store: MemoryDb;
function request(body = "QUOTE 123456789012", to = "+12065550100", signed = true, sid = SID) {
  return new Request("https://example.test/api/twilio/inbound", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(signed ? { "x-twilio-signature": "signed" } : {}) },
    body: new URLSearchParams({ From: "+1 (317) 555-0123", To: to, Body: body, MessageSid: sid, AccountSid: ACCOUNT, MessagingServiceSid: SERVICE }),
  });
}
async function runAcceptedWorker() {
  expect(mocks.after).toHaveBeenCalledTimes(1);
  await mocks.after.mock.calls[0][0]();
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.validate.mockReturnValue(true); mocks.limit.mockReset().mockResolvedValue({ ok: true, unavailable: false });
  mocks.proof.mockReset().mockImplementation(async () => {
    store.tables.sms_inbound_receipts.push({ message_sid: SID, status: "completed" });
    return { handled: true, granted: true };
  });
  mocks.reconcile.mockReset().mockImplementation(async () => store.tables.sms_inbound_receipts.length ? "committed" : "absent");
  mocks.moved.mockReturnValue(false); mocks.owned.mockResolvedValue(null);
  store = new MemoryDb(); mocks.db = store;
  const transportRpc = store.rpc.bind(store);
  mocks.rpc.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => name === "apply_sms_control_keyword" ? { data: true, error: null } : transportRpc(name, args));
  store.rpc = mocks.rpc;
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", ""); vi.stubEnv("VERCEL_ENV", "development");
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-quote-ingress-key");
});
afterEach(() => vi.unstubAllEnvs());
describe("durable pre-router quote proof boundary", () => {
  it("ACKs a signed unknown sender before processing its claimed proof ahead of shared routing", async () => {
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(mocks.proof).not.toHaveBeenCalled(); expect(mocks.shared).not.toHaveBeenCalled();
    const envelope = store.tables.sms_ingress_envelopes[0]; expect(envelope.status).toBe("accepted");
    expect(envelope.params.Body).toBe("QUOTE [redacted]"); expect(JSON.stringify(envelope)).not.toContain("123456789012");
    await runAcceptedWorker();
    expect(mocks.proof).toHaveBeenCalledWith(store, { fromPhone: "+13175550123", toPhone: "+12065550100", body: "QUOTE 123456789012", messageSid: SID, providerMessagingServiceSid: SERVICE });
    expect(envelope.status).toBe("completed"); expect(envelope.checkpoint_stage).toBe("delegated");
    expect(store.tables.sms_platform_replies).toEqual([]); expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.moved).not.toHaveBeenCalled();
  });
  it("never rewrites an old-number proof destination after acceptance", async () => {
    expect((await POST(request("QUOTE 123456789012", "+13175550999"))).status).toBe(200);
    expect(store.tables.sms_ingress_envelopes[0].wire_to).toBe("+13175550999"); await runAcceptedWorker();
    expect(mocks.proof).toHaveBeenCalledWith(store, expect.objectContaining({ toPhone: "+13175550999" })); expect(mocks.moved).not.toHaveBeenCalled();
  });
  it("rejects a forged signature before persistence or a claimed worker", async () => {
    mocks.validate.mockReturnValue(false); expect((await POST(request())).status).toBe(403);
    expect(store.tables.sms_ingress_envelopes).toEqual([]); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.proof).not.toHaveBeenCalled();
  });
  it("rejects unsigned local-development proofs without persisting or granting them", async () => {
    expect((await POST(request(undefined, undefined, false))).status).toBe(403);
    expect(store.tables.sms_ingress_envelopes).toEqual([]); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.proof).not.toHaveBeenCalled();
  });
  it("ACKs durable storage then safely retries a transient proof failure without an agent response", async () => {
    mocks.proof.mockRejectedValueOnce(new Error("database unavailable")); expect((await POST(request())).status).toBe(200);
    expect(mocks.proof).not.toHaveBeenCalled(); await runAcceptedWorker();
    const envelope = store.tables.sms_ingress_envelopes[0]; expect(envelope.status).toBe("accepted");
    expect(envelope.checkpoint_stage).toBe("safe"); expect(envelope.attempts).toBe(1); expect(envelope.reason).toBe("quote_proof_dependency_unavailable");
    expect(envelope.quote_capsule).toBeTruthy(); expect(store.tables.sms_platform_replies).toEqual([]); expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.moved).not.toHaveBeenCalled();
  });
  it.each(["STOP", "HELP"])("keeps claimed %s ahead of proof and ordinary rate limiting", async keyword => {
    expect((await POST(request(keyword))).status).toBe(200); expect(mocks.rpc).not.toHaveBeenCalledWith("apply_sms_control_keyword", expect.anything());
    await runAcceptedWorker();
    expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_control_keyword", expect.objectContaining({ p_message_sid: SID, p_recipient_phone_key: "3175550123", p_keyword: keyword }));
    expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed"); expect(mocks.proof).not.toHaveBeenCalled(); expect(mocks.limit).not.toHaveBeenCalled();
  });
});
describe("legacy webhook shares the signed proof boundary", () => {
  it("classifies shared-line proofs before owned-number/session lookup", async () => {
    expect((await legacyPost(request())).status).toBe(200);
    expect(mocks.proof).toHaveBeenCalledWith(store, expect.objectContaining({ fromPhone: "+13175550123", toPhone: "+12065550100", providerMessagingServiceSid: SERVICE }));
    expect(mocks.shared).not.toHaveBeenCalled(); expect(mocks.moved).not.toHaveBeenCalled();
    expect(mocks.owned).not.toHaveBeenCalled(); expect(mocks.vendorSession).not.toHaveBeenCalled();
  });
  it("rejects a forged signature and returns503 for transient proof failure", async () => {
    mocks.validate.mockReturnValue(false); expect((await legacyPost(request())).status).toBe(403); expect(mocks.proof).not.toHaveBeenCalled();
    mocks.validate.mockReturnValue(true); mocks.proof.mockRejectedValueOnce(new Error("database unavailable")); expect((await legacyPost(request())).status).toBe(503);
  });
  it("records HELP before rate limiting", async () => {
    expect((await legacyPost(request("HELP"))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("apply_sms_control_keyword", expect.objectContaining({ p_keyword: "HELP" })); expect(mocks.limit).not.toHaveBeenCalled(); expect(mocks.proof).not.toHaveBeenCalled();
  });
});
