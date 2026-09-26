/**
 * `/api/manager/app-download-sms` — N068's "Text me the link" control. The
 * message body is always the fixed download URL; only the destination phone
 * is caller-controlled, so this can never become an arbitrary-text relay.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  sendSms: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/twilio", () => ({
  sendSms: mocks.sendSms,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));
vi.mock("@/lib/ios-app-download", () => ({
  iosAppDownloadUrl: () => "https://apps.apple.com/us/app/proplane/id123",
}));

const { POST } = await import("@/app/api/manager/app-download-sms/route");

function post(body: unknown) {
  return POST(
    new Request("https://prop-lane.space/api/manager/app-download-sms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.TWILIO_DEFAULT_FROM = "+12065550199";
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.rateLimit.mockReset().mockResolvedValue({ ok: true });
  mocks.sendSms.mockReset().mockResolvedValue({ sent: true, sid: "SM123" });
});

describe("POST /api/manager/app-download-sms", () => {
  it("401s when signed out", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await post({ phone: "2065551234" });
    expect(res.status).toBe(401);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number", async () => {
    const res = await post({ phone: "abc" });
    expect(res.status).toBe(400);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("sends the fixed download link to the normalized phone", async () => {
    const res = await post({ phone: "(206) 555-1234" });
    expect(res.status).toBe(200);
    expect(mocks.sendSms).toHaveBeenCalledWith(
      "+12065551234",
      expect.stringContaining("https://apps.apple.com/us/app/proplane/id123"),
      "+12065550199",
      expect.objectContaining({ actorUserId: "user-1" }),
    );
  });

  it("never lets the request body control the message text", async () => {
    await post({ phone: "2065551234", message: "ignored", body: "ignored" });
    const sentBody = mocks.sendSms.mock.calls[0]?.[1];
    expect(sentBody).not.toContain("ignored");
  });

  it("429s once the per-account throttle is exhausted", async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false });
    const res = await post({ phone: "2065551234" });
    expect(res.status).toBe(429);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("503s when texting isn't configured", async () => {
    delete process.env.TWILIO_DEFAULT_FROM;
    const res = await post({ phone: "2065551234" });
    expect(res.status).toBe(503);
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("502s when the provider send fails", async () => {
    mocks.sendSms.mockResolvedValue({ sent: false, error: "provider_error" });
    const res = await post({ phone: "2065551234" });
    expect(res.status).toBe(502);
  });
});
