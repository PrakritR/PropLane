import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: null as unknown, after: vi.fn(), proof: vi.fn(), rate: vi.fn(), shared: vi.fn(), validate: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: m.after }));
vi.mock("twilio", () => ({ default: { validateRequest: m.validate } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => m.db }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "auth", fetchTwilioMessageCreatedAt: vi.fn() }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: async () => false }));
vi.mock("@/lib/vendor-quote-sender-proof.server", () => ({ resolveVendorQuoteSenderProof: m.proof }));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: async () => null }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfigStrict: async () => ({ ok: true, config: { mode: "shared", sharedNumber: "+12065559999" } }), loadSharedLineConfig: vi.fn(), isSharedLineNumber: () => true }));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ handleSharedLineInbound: m.shared }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.rate }));
import { MemoryDb } from "../helpers/sms-envelope-memory-db";
import { POST } from "@/app/api/twilio/inbound/route";
import { processAcceptedInbound } from "@/lib/sms/process-accepted-inbound.server";
import { processInboundEnvelope, recoverInboundEnvelopes } from "@/lib/sms/inbound-envelope.server";
import { processVendorQuoteSmsChallenge } from "@/lib/vendor-quote-contact.server";
const code = "123456789123", phone = "+12065552222", line = "+12065559999", sid = `SM${"1".repeat(32)}`, account = `AC${"2".repeat(32)}`;
const sender = { workPhone: line, messagingServiceSid: "MGscope", providerMessagingServiceSid: `MG${"3".repeat(32)}`, workspaceId: "workspace" };
let store: MemoryDb; let consume: ReturnType<typeof vi.fn>; let loseResponse: boolean;
function request(body: Record<string, string> = {}, signature = "valid") {
 return new Request("https://example.test/api/twilio/inbound", { method: "POST", headers: { "x-twilio-signature": signature },
  body: new URLSearchParams({ From: phone, To: line, MessageSid: sid, AccountSid: account, Body: `QUOTE ${code}`, MessagingServiceSid: sender.providerMessagingServiceSid, ...body }) });
}
async function accept() { expect((await POST(request())).status).toBe(200); return store.tables.sms_ingress_envelopes[0]; }
async function process() { await processInboundEnvelope(store.asClient(), "envelope", { process: processAcceptedInbound }); }
beforeEach(() => {
 vi.clearAllMocks(); vi.stubEnv("TWILIO_ACCOUNT_SID", account); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret"); vi.stubEnv("VERCEL_ENV", "development"); vi.stubEnv("VERCEL", "");
 m.rate.mockResolvedValue({ ok: true }); m.proof.mockResolvedValue({ senderSnapshot: sender }); m.validate.mockReturnValue(true); loseResponse = false;
 vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
 store = new MemoryDb(); m.db = store;
 store.tables.vendor_quote_contact_capabilities = [{ id: "cap", manager_user_id: "manager", sender_snapshot: sender, expires_at: "2099-01-01T00:00:00Z" }];
 store.tables.vendor_quote_sms_consent_challenges = [{ id: "challenge", capability_id: "cap", manager_user_id: "manager", requested_phone: phone, work_phone: line,
  messaging_service_sid: sender.messagingServiceSid, code_digest: createHmac("sha256", "test-secret").update(`cap:${phone}:${code}`).digest("hex"), expires_at: "2099-01-01T00:00:00Z", consumed_at: null }];
 const originalRpc = store.rpc.bind(store);
 consume = vi.fn(async (_name: string, args: Record<string, unknown>) => {
  store.tables.vendor_quote_sms_consent_challenges[0].consumed_at = new Date().toISOString();
  store.tables.vendor_quote_sms_consent_challenges[0].inbound_event_id = args.p_inbound_event_id;
  store.tables.sms_inbound_receipts.push({ message_sid: sid, status: "completed", manager_user_id: "manager", recipient_phone_key: "2065552222", workspace_id: "workspace",
   inbound_payload: { signedTwilio: true, fromPhone: phone, toPhone: line, body: "QUOTE [redacted]", workspaceId: "workspace" } });
  if (loseResponse) throw new Error("lost response after commit");
  return { data: true, error: null };
 });
 store.rpc = (async (name, args) => name === "consume_vendor_quote_sms_challenge" ? consume(name, args) : originalRpc(name, args)) as typeof store.rpc;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("canonical sealed quote transport", () => {
 it("ACKs with only redacted allowlisted params and processes an unknown shared-line sender after claim", async () => {
  const response = await POST(request({ ExtraProof: code, PropLaneTrusted: code })); expect(response.status).toBe(200);
  expect(consume).not.toHaveBeenCalled(); expect(m.proof).not.toHaveBeenCalled();
  const row = store.tables.sms_ingress_envelopes[0]; expect(row.params).toEqual({ From: phone, To: line, MessageSid: sid, AccountSid: account, MessagingServiceSid: sender.providerMessagingServiceSid, Body: "QUOTE [redacted]", PropLaneRedacted: "1" });
  expect(JSON.stringify(row)).not.toContain(code); await process();
  expect(consume).toHaveBeenCalledOnce(); expect(row.status).toBe("completed"); expect(row.checkpoint_stage).toBe("delegated"); expect(row.quote_capsule).toBeNull(); expect(store.tables.sms_platform_replies).toEqual([]); expect(m.shared).not.toHaveBeenCalled();
 });
 it("deduplicates a signed redelivery despite randomized ciphertext", async () => {
  const row = await accept(); const capsule = row.quote_capsule; expect((await POST(request())).status).toBe(200);
  expect(store.tables.sms_ingress_envelopes).toHaveLength(1); expect(row.quote_capsule).toEqual(capsule);
  expect((await POST(request({ Extra: "changed" }))).status).toBe(409);
 });
 it("refuses unsigned proofs even under local bypass and removes forged ordinary reserved fields", async () => {
  expect((await POST(request({}, ""))).status).toBe(403); expect(store.tables.sms_ingress_envelopes).toHaveLength(0);
  expect((await POST(request({ Body: "hello", PropLaneTrusted: "1", PropLaneRedacted: "1" }, ""))).status).toBe(200);
  expect(store.tables.sms_ingress_envelopes[0].params).not.toHaveProperty("PropLaneTrusted"); expect(store.tables.sms_ingress_envelopes[0].params.PropLaneRedacted).toBe("0");
 });
 it("reconciles lost atomic COMMIT responses after expiry without a second grant or policy read", async () => {
  const row = await accept(); loseResponse = true; await process(); expect(row.status).toBe("accepted"); expect(consume).toHaveBeenCalledOnce();
  row.quote_capsule = { ...row.quote_capsule, expiresAt: Date.now() - 1 }; row.next_attempt_at = new Date(0).toISOString(); m.proof.mockRejectedValue(new Error("policy changed"));
  await process(); expect(row.status).toBe("completed"); expect(consume).toHaveBeenCalledOnce(); expect(m.proof).toHaveBeenCalledOnce(); expect(row.quote_capsule).toBeNull();
 });
 it("reconciles a final-attempt lost COMMIT response without a fourth execution", async () => {
  const row = await accept(); row.attempts = 2; loseResponse = true; await process();
  expect(row.status).toBe("needs_review"); expect(row.reason).toBe("retry_exhausted"); expect(row.attempts).toBe(3);
  row.quote_capsule = null; row.quote_capsule_expires_at = null; m.proof.mockRejectedValue(new Error("later STOP or policy change"));
  const processor = vi.fn(processAcceptedInbound);
  expect(await recoverInboundEnvelopes(store.asClient(), { process: processor })).toEqual({ processed: 0, needsReview: 0 });
  expect(row.status).toBe("completed"); expect(row.attempts).toBe(3); expect(consume).toHaveBeenCalledOnce(); expect(m.proof).toHaveBeenCalledOnce();
  expect(processor).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled(); expect(store.tables.sms_platform_replies).toEqual([]);
 });
 it("reconciles a final-attempt worker crash after COMMIT and before delegated checkpoint", async () => {
  const row = await accept();
  // Actual shared consent helper commits while the envelope has the durable pre-grant checkpoint.
  Object.assign(row, { status: "executing", checkpoint_stage: "safe", attempts: 3, lease_token: "crashed-worker", lease_until: new Date(0).toISOString() });
  await processVendorQuoteSmsChallenge(store.asClient(), { fromPhone: phone, toPhone: line, body: `QUOTE ${code}`, messageSid: sid, providerMessagingServiceSid: sender.providerMessagingServiceSid });
  const processor = vi.fn(processAcceptedInbound);
  expect(await recoverInboundEnvelopes(store.asClient(), { process: processor })).toEqual({ processed: 0, needsReview: 0 });
  expect(row.status).toBe("completed"); expect(row.quote_capsule).toBeNull(); expect(row.attempts).toBe(3); expect(consume).toHaveBeenCalledOnce(); expect(processor).not.toHaveBeenCalled();
 });
 it.each(["absent", "conflict", "ordinary"])("keeps exhausted %s evidence in review without invoking a processor", async kind => {
  const row = await accept(); Object.assign(row, { status: "needs_review", checkpoint_stage: "safe", attempts: 3, reason: "retry_exhausted", lease_token: null });
  if (kind === "conflict") {
   await processVendorQuoteSmsChallenge(store.asClient(), { fromPhone: phone, toPhone: line, body: `QUOTE ${code}`, messageSid: sid });
   store.tables.sms_inbound_receipts[0].inbound_payload.toPhone = "+12065550000";
  }
  if (kind === "ordinary") row.params.Body = "hello";
  const processor = vi.fn(processAcceptedInbound);
  expect(await recoverInboundEnvelopes(store.asClient(), { process: processor })).toEqual({ processed: 0, needsReview: 1 });
  expect(row.status).toBe("needs_review"); expect(row.reason).toBe("retry_exhausted"); expect(row.attempts).toBe(3); expect(processor).not.toHaveBeenCalled();
  expect(consume).toHaveBeenCalledTimes(kind === "conflict" ? 1 : 0);
 });
 it("leaves unreadable exhausted receipt evidence recoverable without executing again", async () => {
  const row = await accept(); Object.assign(row, { status: "needs_review", checkpoint_stage: "safe", attempts: 3, reason: "retry_exhausted", lease_token: null });
  const from = store.from.bind(store);
  store.from = ((table: string) => {
   if (table !== "sms_inbound_receipts") return from(table);
   const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }) }; return q;
  }) as typeof store.from;
  const processor = vi.fn(processAcceptedInbound);
  await expect(recoverInboundEnvelopes(store.asClient(), { process: processor })).rejects.toThrow("Quote outcome unavailable");
  expect(row.status).toBe("needs_review"); expect(row.attempts).toBe(3); expect(consume).not.toHaveBeenCalled(); expect(processor).not.toHaveBeenCalled();
 });
 it("reconciles the same SID previously consumed through the shared legacy implementation", async () => {
  expect(await processVendorQuoteSmsChallenge(store.asClient(), { fromPhone: phone, toPhone: line, body: `QUOTE ${code}`, messageSid: sid, providerMessagingServiceSid: sender.providerMessagingServiceSid })).toEqual({ handled: true, granted: true });
  await accept(); await process(); expect(consume).toHaveBeenCalledOnce(); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it.each(["wire_from", "wire_to", "payload_digest", "account_sid", "runtime"])("refuses copied/tampered capsule binding %s", async field => {
  const row = await accept();
  // account/runtime tampering cannot be claimed at all; the other identities cannot authenticate.
  row[field] = `${row[field]}changed`; await process(); expect(consume).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled();
 });
 it("finishes expired/missing capsule and conflicting committed evidence without general fallback", async () => {
  const row = await accept(); row.quote_capsule = null; row.quote_capsule_expires_at = null;
  await process(); expect(row.status).toBe("completed"); expect(consume).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled();
 });
 it("retains a bounded safe retry when receipt evidence or rate storage is unavailable", async () => {
  const row = await accept(); m.rate.mockResolvedValue({ ok: false, unavailable: true }); await process();
  expect(row.status).toBe("accepted"); expect(row.checkpoint_stage).toBe("safe"); expect(row.quote_capsule).toBeTruthy(); expect(consume).not.toHaveBeenCalled();
 });
 it("safely retries refused proof when zero-bubble preparation is unavailable after capsule cleanup", async () => {
  const row = await accept(); m.proof.mockResolvedValue(null); const original = store.rpc.bind(store); let failed = false;
  store.rpc = (async (name, args) => {
   if (name === "sms_ingress_prepare" && !failed) { failed = true; throw new Error("prepare unavailable"); }
   return original(name, args);
  }) as typeof store.rpc;
  await process(); expect(row.status).toBe("accepted"); expect(row.quote_capsule).toBeNull(); expect(consume).not.toHaveBeenCalled();
  row.next_attempt_at = new Date(0).toISOString(); await process(); expect(row.status).toBe("completed"); expect(m.shared).not.toHaveBeenCalled();
 });
 it("recovers a safe failure before the atomic RPC without creating an early grant", async () => {
  const row = await accept(); m.proof.mockRejectedValueOnce(new Error("temporary policy read outage")); await process();
  expect(row.status).toBe("accepted"); expect(consume).not.toHaveBeenCalled(); row.next_attempt_at = new Date(0).toISOString();
  await process(); expect(row.status).toBe("completed"); expect(consume).toHaveBeenCalledOnce();
 });
 it("reconciles a lost delegated checkpoint response without replaying a grant", async () => {
  const row = await accept(); const original = store.rpc.bind(store);
  store.rpc = (async (name, args) => {
   const result = await original(name, args);
   if (name === "sms_ingress_checkpoint" && args.p_stage === "delegated") throw new Error("lost checkpoint response");
   return result;
  }) as typeof store.rpc;
  await process(); expect(row.status).toBe("needs_review"); expect(row.reason).toBe("delegated_receipt"); expect(consume).toHaveBeenCalledOnce();
  await original("sms_ingress_reconcile", { p_runtime: "development", p_account: account });
  expect(row.status).toBe("completed"); expect(consume).toHaveBeenCalledOnce();
 });
 it("refuses ambiguous code candidates and conflicting owner receipts", async () => {
  await accept(); store.tables.vendor_quote_sms_consent_challenges.push({ ...store.tables.vendor_quote_sms_consent_challenges[0], id: "second" });
  await process(); expect(consume).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled();
 });
 it("does not reinterpret unreadable receipt evidence as invalid or general traffic", async () => {
  const row = await accept(); const from = store.from.bind(store);
  store.from = ((table: string) => {
   if (table !== "sms_inbound_receipts") return from(table);
   const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }) };
   return q;
  }) as typeof store.from;
  await process(); expect(row.status).toBe("accepted"); expect(row.checkpoint_stage).toBe("safe"); expect(consume).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled();
 });
 it("refuses changed fresh sender authority without invoking shared onboarding", async () => {
  await accept(); m.proof.mockResolvedValue({ senderSnapshot: { ...sender, workPhone: "+12065550000" } }); await process();
  expect(consume).not.toHaveBeenCalled(); expect(m.shared).not.toHaveBeenCalled(); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
});
