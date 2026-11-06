import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ accept: vi.fn(), process: vi.fn(), after: vi.fn(), validate: vi.fn(), shield: vi.fn() }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: m.after }));
vi.mock("twilio", () => ({ default: { validateRequest: m.validate } }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "test" }));
vi.mock("@/lib/protected-accounts.server", () => ({ isShieldedRecipient: m.shield }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/sms/inbound-envelope.server", () => ({ acceptInboundEnvelope: m.accept, processInboundEnvelope: m.process, smsEnvelopeRuntime: () => "development" }));
vi.mock("@/lib/sms/process-accepted-inbound.server", () => ({ processAcceptedInbound: vi.fn() }));
import { POST } from "@/app/api/twilio/inbound/route";

function request(body: Record<string, string> = {}, signature = "valid") {
 return new Request("https://example.test/api/twilio/inbound", { method: "POST", headers: { "x-twilio-signature": signature }, body: new URLSearchParams({ From: "+12065552222", To: "+12065559999", Body: "hello", MessageSid: `SM${"1".repeat(32)}`, AccountSid: "ACtest", ...body }) });
}
beforeEach(() => {
 vi.useFakeTimers(); vi.clearAllMocks(); vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest"); vi.stubEnv("VERCEL", "1");
 m.accept.mockResolvedValue({ kind: "accepted", id: "receipt" }); m.validate.mockReturnValue(true); m.shield.mockResolvedValue(false);
 vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("durable inbound acknowledgement", () => {
 it.each(["shared handled reply", "shared continuation"])("acknowledges %s before a 16-second downstream turn", async () => {
  m.process.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 16_000)));
  const response = await POST(request());
  expect(response.status).toBe(200); expect(await response.text()).toContain("<Response></Response>");
  expect(m.accept).toHaveBeenCalledOnce(); expect(m.process).not.toHaveBeenCalled(); expect(m.after).toHaveBeenCalledOnce();
  let done = false; const deferred = m.after.mock.calls[0][0]().then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(15_000); expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000); await deferred;
 });
 it("never acknowledges storage failure or schedules undurable work", async () => {
  m.accept.mockResolvedValue({ kind: "unavailable" });
  expect((await POST(request())).status).toBe(503); expect(m.after).not.toHaveBeenCalled();
 });
 it("rejects changed payload identity and accepts exact durable retry", async () => {
  m.accept.mockResolvedValueOnce({ kind: "conflict" }); expect((await POST(request())).status).toBe(409);
  m.accept.mockResolvedValueOnce({ kind: "duplicate", id: "receipt" }); expect((await POST(request())).status).toBe(200);
 });
 it("verifies signature and provider account before persistence", async () => {
  expect((await POST(request({}, ""))).status).toBe(403);
  m.validate.mockReturnValue(false); expect((await POST(request())).status).toBe(403);
  m.validate.mockReturnValue(true); expect((await POST(request({ AccountSid: "other" }))).status).toBe(403);
  expect(m.accept).not.toHaveBeenCalled();
 });
 it("bounds shield latency and never acknowledges dropped work as accepted", async () => {
  m.shield.mockImplementation(() => new Promise(() => {}));
  const pending = POST(request()); await vi.advanceTimersByTimeAsync(2001);
  expect((await pending).status).toBe(503); expect(m.accept).not.toHaveBeenCalled(); expect(m.after).not.toHaveBeenCalled();
 });
 it("redacts stored numbers while binding deduplication to original wire bytes", async () => {
  const response = await POST(request({ Body: "Card 4242424242424242" })); expect(response.status).toBe(200);
  const saved = m.accept.mock.calls[0][1]; expect(saved.params.Body).not.toContain("4242424242424242"); expect(saved.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
 });
 it("validates signatures against the configured URL without provider retry fragments", async () => {
  vi.stubEnv("TWILIO_WEBHOOK_URL", "https://proplane.ai/api/twilio/inbound#rp=ct,5xx&rc=2");
  expect((await POST(request())).status).toBe(200);
  expect(m.validate).toHaveBeenCalledWith("test", "valid", "https://proplane.ai/api/twilio/inbound", expect.anything());
 });
});
