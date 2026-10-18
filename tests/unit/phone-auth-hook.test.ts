import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendPhoneAuthCode: vi.fn(), claimPhoneAuthHookDelivery: vi.fn() }));
vi.mock("@/lib/auth/phone-otp-delivery.server", () => mocks);

import { POST } from "@/app/api/auth/hooks/send-sms/route";

const SECRET_BYTES = "test-hook-signature-secret-32bytes";
const SECRET = `v1,whsec_${Buffer.from(SECRET_BYTES).toString("base64")}`;
const USER = "c034506b-63ec-4a64-a8c8-792a677a31d0";
const EVENT = { user: { id: USER, phone: "+12065550142" }, sms: { otp: "123456" } };

function request(payload: unknown = EVENT, offsetSeconds = 0, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const id = "msg_phone_1";
  const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
  const signature = createHmac("sha256", SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request("https://app.test/api/auth/hooks/send-sms", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
      ...headers,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SEND_SMS_HOOK_SECRET", SECRET);
  mocks.sendPhoneAuthCode.mockResolvedValue(true);
  mocks.claimPhoneAuthHookDelivery.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("Supabase Send SMS hook", () => {
  it("accepts the standard webhook signature and sends only the signed destination/code", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(mocks.sendPhoneAuthCode).toHaveBeenCalledExactlyOnceWith("+12065550142", "123456", USER);
  });

  it("accepts Supabase's non-US E.164 serialization without a plus", async () => {
    const response = await POST(request({ ...EVENT, user: { ...EVENT.user, phone: "442079460958" } }));
    expect(response.status).toBe(200);
    expect(mocks.sendPhoneAuthCode).toHaveBeenCalledWith("+442079460958", "123456", USER);
  });

  it("refuses an unconfigured secret without sending", async () => {
    vi.stubEnv("SUPABASE_SEND_SMS_HOOK_SECRET", "");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])("refuses missing %s", async (header) => {
    expect((await POST(request(EVENT, 0, { [header]: "" }))).status).toBe(401);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it("refuses an invalid signature before any delivery", async () => {
    expect((await POST(request(EVENT, 0, { "webhook-signature": "v1,invalid" }))).status).toBe(401);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it.each([-301, 301])("refuses a signed timestamp outside the freshness window (%s seconds)", async (offset) => {
    expect((await POST(request(EVENT, offset))).status).toBe(401);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it("refuses body tampering", async () => {
    const signed = request();
    const tampered = new Request(signed.url, {
      method: "POST", headers: signed.headers,
      body: JSON.stringify({ ...EVENT, sms: { otp: "654321" } }),
    });
    expect((await POST(tampered)).status).toBe(401);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { user: EVENT.user },
    { ...EVENT, user: { ...EVENT.user, phone: "bad" } },
    { ...EVENT, user: { ...EVENT.user, id: "untrusted-actor" } },
    { ...EVENT, sms: { otp: 123456 } },
    { ...EVENT, sms: { otp: "12345" } },
    { ...EVENT, sms: { otp: "1234567" } },
  ])("refuses malformed signed payload %#", async (payload) => {
    expect((await POST(request(payload))).status).toBe(400);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it("returns a neutral provider failure with no OTP or phone", async () => {
    mocks.sendPhoneAuthCode.mockRejectedValue(new Error("provider failed for +12065550142 code 123456"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { http_code: 503, message: "Unable to send verification code." } });
  });

  it("never reports success when the provider did not accept the code", async () => {
    mocks.sendPhoneAuthCode.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(503);
  });

  it("refuses a correctly signed hook with no pending delivery reservation", async () => {
    mocks.claimPhoneAuthHookDelivery.mockResolvedValue(false);
    expect((await POST(request())).status).toBe(429);
    expect(mocks.sendPhoneAuthCode).not.toHaveBeenCalled();
  });

  it("does not resend the same challenge for duplicate signed hooks", async () => {
    mocks.claimPhoneAuthHookDelivery.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(429);
    expect(mocks.sendPhoneAuthCode).toHaveBeenCalledTimes(1);
  });
});
