import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rate: vi.fn(), suppression: vi.fn(), send: vi.fn(), request: vi.fn(), verify: vi.fn(), db: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, clientIpFrom: () => "203.0.113.1" }));
vi.mock("@/lib/sms-consent", async (original) => ({ ...(await original<typeof import("@/lib/sms-consent")>()), readSmsSuppressionState: mocks.suppression }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: mocks.send }));
vi.mock("@/lib/one-number/phone-otp.server", async (original) => ({
  ...(await original<typeof import("@/lib/one-number/phone-otp.server")>()),
  requestPhoneOtp: mocks.request, verifyPhoneOtp: mocks.verify,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
import { POST } from "@/app/api/public/text-demo-link/route";

const PHONE = "+12065550123";
function request(body: unknown = { phone: PHONE, consent: true }, headers: Record<string, string> = {}) {
  return new Request("https://proplane.ai/api/public/text-demo-link", {
    method: "POST", headers: { origin: "https://proplane.ai", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const verifyBody = { phone: PHONE, action: "verify", otp: "123456" };
const keys = () => mocks.rate.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
  mocks.send.mockResolvedValue({ ok: true, sid: "SMtest" });
  mocks.request.mockImplementation(async (_db, input) => ({ ok: await input.send("424242", "challenge"), challengeId: "challenge" }));
  mocks.verify.mockResolvedValue({ ok: true });
});

describe("public text demo link: step one texts a code only", () => {
  it("texts a code containing nothing but the code, never the link", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, codeSent: true });
    expect(mocks.request).toHaveBeenCalledWith(mocks.db, expect.objectContaining({ phoneKey: "2065550123", purpose: "public_bind", subjectId: "demo-link" }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const text = mocks.send.mock.calls[0]![1].body as string;
    expect(text).toContain("424242");
    expect(text).not.toContain("proplane.ai");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("validates, then reserves IP and phone before the shared code budget, which is last", async () => {
    await POST(request());
    expect(keys()).toEqual(["text-demo:send-ip:203.0.113.1", `text-demo:code-phone:${PHONE}`, "text-demo:code-global"]);
    expect(mocks.rate.mock.invocationCallOrder.at(-1)!).toBeLessThan(mocks.request.mock.invocationCallOrder[0]!);
  });

  it("invalid input never spends any bucket, so it cannot lock out the form", async () => {
    for (const body of [{ phone: "bad", consent: true }, { phone: PHONE, consent: false }, { phone: "+442079460958", consent: true }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("fails closed when send bucket %s is exhausted, before texting", async (bucket) => {
    mocks.rate.mockImplementation(async () => ({ ok: mocks.rate.mock.calls.length - 1 !== bucket }));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("answers 429 when the phone's own code allowance is used up", async () => {
    mocks.request.mockResolvedValue({ ok: false, reason: "rate_limited" });
    expect((await POST(request())).status).toBe(429);
  });

  it.each([{ ok: true, optedOut: true }, { ok: false, error: "db" }])("fails closed on suppression %#", async (result) => {
    mocks.suppression.mockResolvedValue(result);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("refuses a limiter-store outage", async () => {
    mocks.rate.mockResolvedValue({ ok: false, unavailable: true });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("preserves uncertainty when the provider response was lost", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "delivery_unknown" });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Delivery isn't confirmed. Check your phone or view the dashboard.", deliveryUnknown: true });
  });

  it.each(["quiet_hours", "not_shared_mode", "provider_error"])("never reports a code sent for %s", async (reason) => {
    mocks.send.mockResolvedValue({ ok: false, reason });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "We couldn't send the text. View the dashboard here instead." });
  });
});

describe("public text demo link: the link follows only a verified code", () => {
  it("texts the canonical link after the code checks out, spending the shared budget only then", async () => {
    const response = await POST(request(verifyBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.verify).toHaveBeenCalledWith(mocks.db, expect.objectContaining({ phoneKey: "2065550123", purpose: "public_bind", subjectId: "demo-link", code: "123456" }));
    expect(keys()).toEqual(["text-demo:verify-ip:203.0.113.1", `text-demo:phone:${PHONE}`, "text-demo:global"]);
    expect(mocks.send).toHaveBeenCalledWith(mocks.db, {
      to: PHONE, purpose: "requested_demo_link", body: "PropLane: Here is your link: https://proplane.ai/#dashboard Reply STOP to opt out.",
    });
    expect(mocks.verify.mock.invocationCallOrder[0]!).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
  });

  it.each(["wrong_code", "no_challenge", "expired"])("a %s texts nothing and spends no shared budget", async (reason) => {
    mocks.verify.mockResolvedValue({ ok: false, reason });
    expect((await POST(request(verifyBody))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(keys()).not.toContain("text-demo:global");
  });

  it("a locked phone is refused without a text", async () => {
    mocks.verify.mockResolvedValue({ ok: false, reason: "locked" });
    expect((await POST(request(verifyBody))).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("an exhausted shared budget refuses the link", async () => {
    mocks.rate.mockImplementation(async (key: string) => ({ ok: key !== "text-demo:global" }));
    expect((await POST(request(verifyBody))).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("consent is not needed for verify, but a code string is", async () => {
    expect((await POST(request({ phone: PHONE, action: "verify" }))).status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("preserves uncertainty on the link text", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "delivery_unknown" });
    const response = await POST(request(verifyBody));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ deliveryUnknown: true });
  });
});

describe("public text demo link: request hygiene", () => {
  it.each(["", "https://evil.test"])("refuses missing/foreign origin %s", async (origin) => {
    expect((await POST(request(undefined, { origin }))).status).toBe(403);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([{ phone: PHONE, consent: "true" }, { phone: "+12065550123hello", consent: true }, null, [], "invalid-json"])(
    "rejects invalid body/consent %#", async (body) => {
      expect((await POST(request(body))).status).toBe(400);
      expect(mocks.send).not.toHaveBeenCalled();
    });

  it("refuses oversized streams and non-JSON input", async () => {
    expect((await POST(request("x".repeat(2049)))).status).toBe(400);
    expect((await POST(request(undefined, { "content-type": "text/plain" }))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
