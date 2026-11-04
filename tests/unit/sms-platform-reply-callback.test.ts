import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), validate: vi.fn() }));
vi.mock("twilio", () => ({ default: { validateRequest: mocks.validate } }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "secret" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: vi.fn() }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfigStrict: vi.fn() }));
import { POST } from "@/app/api/twilio/platform-reply-status/route";

const token = "11111111-1111-4111-8111-111111111111";
const url = `https://example.test/api/twilio/platform-reply-status?token=${token}`;
const valid = { AccountSid: "ACtest", From: "+12065559999", To: "+12065552222", MessageSid: "SMout", MessageStatus: "delivered" };
function request(params = valid, requestUrl = url) { return new Request(requestUrl, { method: "POST", headers: { "x-twilio-signature": "signature" }, body: new URLSearchParams(params) }); }
beforeEach(() => {
 vi.stubEnv("TWILIO_ACCOUNT_SID", "ACtest"); vi.stubEnv("VERCEL_ENV", "development"); vi.stubEnv("TWILIO_WEBHOOK_URL", "https://example.test/api/twilio/inbound"); vi.stubEnv("TWILIO_PLATFORM_REPLY_STATUS_URL", "");
 mocks.validate.mockReset().mockReturnValue(true); mocks.rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("platform reply callback", () => {
 it("verifies the canonical token URL and binds all wire and account fields", async () => {
  expect((await POST(request())).status).toBe(204);
  expect(mocks.validate).toHaveBeenCalledWith("secret", "signature", url, valid);
  expect(mocks.rpc).toHaveBeenCalledWith("sms_platform_reply_callback", { p_token: token, p_runtime: "development", p_account: "ACtest", p_from: valid.From, p_to: valid.To, p_sid: "SMout", p_status: "delivered", p_rank: 40 });
 });
 it("rejects invalid signatures, account mismatches and altered callback query", async () => {
  mocks.validate.mockReturnValueOnce(false); expect((await POST(request())).status).toBe(403);
  expect((await POST(request({ ...valid, AccountSid: "ACother" }))).status).toBe(403);
  expect((await POST(request(valid, `${url}&other=1`))).status).toBe(403);
  expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it("rejects callback binding refused by storage and retries on storage errors", async () => {
  mocks.rpc.mockResolvedValueOnce({ data: false, error: null }).mockResolvedValueOnce({ data: null, error: { code: "unavailable" } });
  expect((await POST(request())).status).toBe(403); expect((await POST(request())).status).toBe(503);
 });
 it("passes the current runtime to storage and never accepts an unknown status", async () => {
  vi.stubEnv("VERCEL_ENV", "preview"); expect((await POST(request())).status).toBe(204);
  expect(mocks.rpc.mock.calls[0][1].p_runtime).toBe("preview");
  expect((await POST(request({ ...valid, MessageStatus: "invented" }))).status).toBe(403);
 });
});
