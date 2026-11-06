import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), config: vi.fn() }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: mocks.send }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfigStrict: mocks.config }));
import { acceptInboundEnvelope, processInboundEnvelope, recoverInboundEnvelopes } from "@/lib/sms/inbound-envelope.server";
import { durableSmsCheckpoint, getDurableSmsCheckpoint, SafeSmsIngressRetry } from "@/lib/sms/durable-ingress-context.server";
import { dispatchPlatformReplies } from "@/lib/sms/platform-reply-dispatch.server";

import { MemoryDb } from "../helpers/sms-envelope-memory-db";
const sender = "+12065559999";
const input = { sid: "SM1", wireFrom: "+12065552222", wireTo: sender, params: { Body: "redacted" }, payloadDigest: "a".repeat(64), runtime: "development" };
let store: MemoryDb;
beforeEach(() => {
 vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest"); vi.stubEnv("VERCEL_ENV", "development"); vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.test/api/twilio/inbound"); vi.stubEnv("TWILIO_PLATFORM_REPLY_STATUS_URL", "");
 mocks.send.mockReset().mockResolvedValue({ ok: true, sid: "SMout" }); mocks.config.mockResolvedValue({ ok: true, config: { mode: "shared", sharedNumber: sender } }); store = new MemoryDb();
});
afterEach(() => vi.unstubAllEnvs());
async function accept() { const result = await acceptInboundEnvelope(store.asClient(), input); expect(result.kind).toBe("accepted"); }
const answer = async () => ({ sender, bubbles: [{ body: "first" }, { body: "second" }] });

describe("durable inbound transport", () => {
 it("acknowledges only exact duplicate wire identity and digest", async () => {
  await accept(); expect((await acceptInboundEnvelope(store.asClient(), input)).kind).toBe("duplicate");
  expect((await acceptInboundEnvelope(store.asClient(), { ...input, payloadDigest: "b".repeat(64) })).kind).toBe("conflict");
  expect((await acceptInboundEnvelope(store.asClient(), { ...input, wireFrom: "+12065553333" })).kind).toBe("conflict");
  expect((await acceptInboundEnvelope(store.asClient(), { ...input, runtime: "production" })).kind).toBe("unavailable");
 });
 it("claims concurrent executions once and preserves prepared bubble order", async () => {
  await accept(); const process = vi.fn(answer);
  await Promise.all([processInboundEnvelope(store.asClient(), "envelope", { process }), processInboundEnvelope(store.asClient(), "envelope", { process })]);
  expect(process).toHaveBeenCalledTimes(1); expect(mocks.send.mock.calls.map(c => c[1].body)).toEqual(["first", "second"]);
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("allows only one submission when workers race on a prepared bubble", async () => {
  await accept();
  let release!: (value: { ok: true; sid: string }) => void;
  mocks.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = processInboundEnvelope(store.asClient(), "envelope", { process: async () => ({ sender, bubbles: [{ body: "one" }] }) });
  while (!release) await Promise.resolve();
  await dispatchPlatformReplies(store.asClient(), "envelope");
  expect(mocks.send).toHaveBeenCalledTimes(1);
  release({ ok: true, sid: "SMout" }); await first;
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("keeps callback acceptance when it arrives before the send resolves", async () => {
  await accept();
  mocks.send.mockImplementationOnce(async () => {
   Object.assign(store.tables.sms_platform_replies[0], { status: "accepted", provider_sid: "SMout", delivery_status: "delivered" });
   return { ok: true, sid: "SMout" };
  });
  await processInboundEnvelope(store.asClient(), "envelope", { process: async () => ({ sender, bubbles: [{ body: "one" }] }) });
  expect(store.tables.sms_platform_replies[0].delivery_status).toBe("delivered");
  await dispatchPlatformReplies(store.asClient(), "envelope");
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("retries a definite pre-provider failure but freezes a blocked recipient", async () => {
  await accept(); mocks.send.mockResolvedValueOnce({ ok: false, reason: "provider_error" }).mockResolvedValueOnce({ ok: false, reason: "opted_out" });
  await processInboundEnvelope(store.asClient(), "envelope", { process: answer });
  expect(store.tables.sms_platform_replies[0].status).toBe("prepared");
  store.tables.sms_platform_replies[0].next_attempt_at = new Date(0).toISOString();
  await dispatchPlatformReplies(store.asClient(), "envelope");
  expect(mocks.send).toHaveBeenCalledTimes(2); expect(store.tables.sms_platform_replies[0].status).toBe("blocked"); expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review");
 });
 it("freezes an uncertain processor and never repeats its effects", async () => {
  await accept(); const process = vi.fn(async () => { throw Error("crash after effect"); });
  await processInboundEnvelope(store.asClient(), "envelope", { process });
  await recoverInboundEnvelopes(store.asClient(), { process });
  expect(process).toHaveBeenCalledTimes(1); expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review"); expect(mocks.send).not.toHaveBeenCalled();
 });
 it("does not resend after unknown provider acceptance", async () => {
  await accept(); mocks.send.mockResolvedValue({ ok: false, reason: "delivery_unknown" });
  await processInboundEnvelope(store.asClient(), "envelope", { process: answer });
  await recoverInboundEnvelopes(store.asClient(), { process: answer });
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(store.tables.sms_platform_replies[0].status).toBe("delivery_unknown"); expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review");
 });
 it("does not resend when provider acceptance cannot be recorded", async () => {
  await accept(); store.failOutcome = true;
  await expect(processInboundEnvelope(store.asClient(), "envelope", { process: answer })).rejects.toThrow("Reply outcome unavailable");
  store.failOutcome = false; store.tables.sms_platform_replies[0].submit_lease_until = new Date(Date.now() - 1000).toISOString();
  await dispatchPlatformReplies(store.asClient(), "envelope");
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(store.tables.sms_platform_replies[0].status).toBe("delivery_unknown");
 });
 it("does not process expired or cross-environment envelopes", async () => {
  await accept(); const process = vi.fn(answer); store.tables.sms_ingress_envelopes[0].expires_at = new Date(Date.now() - 1000).toISOString();
  await recoverInboundEnvelopes(store.asClient(), { process }); expect(store.tables.sms_ingress_envelopes[0].status).toBe("expired");
  store.tables.sms_ingress_envelopes[0].status = "accepted"; store.tables.sms_ingress_envelopes[0].runtime = "production"; store.tables.sms_ingress_envelopes[0].expires_at = new Date(Date.now() + 100_000).toISOString();
  await processInboundEnvelope(store.asClient(), "envelope", { process }); expect(process).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
 });
 it("freezes when sender changes after routing", async () => {
  await accept(); mocks.send.mockResolvedValue({ ok: false, reason: "no_shared_number" });
  await processInboundEnvelope(store.asClient(), "envelope", { process: answer });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review"); expect(mocks.send).toHaveBeenCalledTimes(1);
 });
 it("retries a durable control decision without changing its branch", async () => {
  await accept(); let calls = 0;
  const process = vi.fn(async () => {
   const saved = getDurableSmsCheckpoint();
   if (!saved?.controlKeyword) await durableSmsCheckpoint({ stage: "control", controlKeyword: "START" });
   else expect(saved.controlKeyword).toBe("START");
   if (++calls === 1) throw new SafeSmsIngressRetry("control_unavailable");
   return { bubbles: [] };
  });
  await processInboundEnvelope(store.asClient(), "envelope", { process });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("accepted");
  store.tables.sms_ingress_envelopes[0].next_attempt_at = new Date(0).toISOString();
  await recoverInboundEnvelopes(store.asClient(), { process });
  expect(process).toHaveBeenCalledTimes(2); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("reconciles a delegated receipt without rerunning the processor", async () => {
  await accept(); const process = vi.fn(async () => { await durableSmsCheckpoint({ stage: "delegated", delegatedSid: "SM1" }); throw Error("owner pending"); });
  await processInboundEnvelope(store.asClient(), "envelope", { process });
  store.tables.sms_inbound_receipts.push({ message_sid: "SM1", status: "completed" });
  await recoverInboundEnvelopes(store.asClient(), { process });
  expect(process).toHaveBeenCalledTimes(1); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("resumes only untouched bubbles after callback resolution", async () => {
  await accept(); mocks.send.mockResolvedValueOnce({ ok: false, reason: "delivery_unknown" });
  const process = vi.fn(answer); await processInboundEnvelope(store.asClient(), "envelope", { process });
  Object.assign(store.tables.sms_platform_replies[0], { status: "accepted", provider_sid: "SMout" });
  await Promise.all([recoverInboundEnvelopes(store.asClient(), { process }), recoverInboundEnvelopes(store.asClient(), { process })]);
  expect(mocks.send.mock.calls.map(c => c[1].body)).toEqual(["first", "second"]); expect(process).toHaveBeenCalledTimes(1);
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("retries config and suppression outages using the persisted reply", async () => {
  await accept(); mocks.send.mockResolvedValueOnce({ ok: false, reason: "config_unavailable" }).mockResolvedValueOnce({ ok: false, reason: "suppression_unavailable" }).mockResolvedValueOnce({ ok: true, sid: "SMout" });
  const process = vi.fn(async () => ({ sender, bubbles: [{ body: "original", mediaUrls: ["https://example.test/a"] }] }));
  await processInboundEnvelope(store.asClient(), "envelope", { process });
  store.tables.sms_platform_replies[0].next_attempt_at = new Date(0).toISOString();
  await dispatchPlatformReplies(store.asClient(), "envelope");
  store.tables.sms_platform_replies[0].next_attempt_at = new Date(0).toISOString();
  await dispatchPlatformReplies(store.asClient(), "envelope");
  expect(process).toHaveBeenCalledTimes(1); expect(mocks.send.mock.calls.map(c => [c[1].body,c[1].mediaUrls])).toEqual(Array(3).fill(["original", ["https://example.test/a"]]));
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });

 it("completes one resolved bubble without another submission", async () => {
  await accept(); mocks.send.mockResolvedValueOnce({ ok: false, reason: "delivery_unknown" });
  const process = vi.fn(async () => ({ sender, bubbles: [{ body: "only" }] }));
  await processInboundEnvelope(store.asClient(), "envelope", { process });
  Object.assign(store.tables.sms_platform_replies[0], { status: "accepted", provider_sid: "SMout" });
  await recoverInboundEnvelopes(store.asClient(), { process });
  expect(mocks.send).toHaveBeenCalledTimes(1); expect(store.tables.sms_ingress_envelopes[0].status).toBe("completed");
 });
 it("does not reopen expired or independently blocked work", async () => {
  await accept(); mocks.send.mockResolvedValueOnce({ ok: false, reason: "delivery_unknown" });
  await processInboundEnvelope(store.asClient(), "envelope", { process: answer });
  Object.assign(store.tables.sms_platform_replies[0], { status: "accepted", provider_sid: "SMout" });
  store.tables.sms_platform_replies[1].status = "blocked";
  await recoverInboundEnvelopes(store.asClient(), { process: answer });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review");
  store.tables.sms_platform_replies[1].status = "prepared";
  store.tables.sms_ingress_envelopes[0].expires_at = new Date(0).toISOString();
  await recoverInboundEnvelopes(store.asClient(), { process: answer });
  expect(store.tables.sms_ingress_envelopes[0].status).toBe("needs_review"); expect(mocks.send).toHaveBeenCalledTimes(1);
 });

});
