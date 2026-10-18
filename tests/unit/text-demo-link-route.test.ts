import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rate: vi.fn(), suppression: vi.fn(), send: vi.fn(), db: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, clientIpFrom: () => "203.0.113.1" }));
vi.mock("@/lib/sms-consent", () => ({ readSmsSuppressionState: mocks.suppression }));
vi.mock("@/lib/one-number/lead-send.server", () => ({ sendPlatformLeadText: mocks.send }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
import { POST } from "@/app/api/public/text-demo-link/route";

function request(body: unknown = { phone: "+12065550123", consent: true }, headers: Record<string, string> = {}) {
  return new Request("https://proplane.ai/api/public/text-demo-link", {
    method: "POST", headers: { origin: "https://proplane.ai", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.suppression.mockResolvedValue({ ok: true, optedOut: false });
  mocks.send.mockResolvedValue({ ok: true, sid: "SMtest" });
});

describe("public text demo link", () => {
  it("reserves IP, phone and global limits before sending a canonical demo link", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.rate.mock.calls).toEqual([
      ["text-demo:ip:203.0.113.1", 5, 3_600_000],
      ["text-demo:phone:+12065550123", 1, 3_600_000],
      ["text-demo:global", 50, 3_600_000],
    ]);
    expect(mocks.send).toHaveBeenCalledWith(mocks.db, {
      to: "+12065550123", purpose: "requested_demo_link", body: "PropLane: Your demo is ready: https://proplane.ai/?demo=open Reply DEMO to try it by text. Reply STOP to opt out.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["", "https://evil.test"])("refuses missing/foreign origin %s", async (origin) => {
    expect((await POST(request(undefined, { origin }))).status).toBe(403);
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { phone: "+12065550123", consent: false }, { phone: "+12065550123", consent: "true" },
    { phone: "bad", consent: true }, { phone: "+12065550123hello", consent: true }, null, [], "invalid-json",
  ])("rejects invalid body/consent %#", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses oversized streams and non-JSON input", async () => {
    expect((await POST(request("x".repeat(2049)))).status).toBe(400);
    expect((await POST(request(undefined, { "content-type": "text/plain" }))).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("fails closed when abuse dimension %s is exhausted", async (dimension) => {
    mocks.rate.mockImplementation(async () => ({ ok: mocks.rate.mock.calls.length - 1 !== dimension }));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a limiter-store outage", async () => {
    mocks.rate.mockResolvedValue({ ok: false, unavailable: true });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([{ ok: true, optedOut: true }, { ok: false, error: "db" }])("fails closed on suppression %#", async (result) => {
    mocks.suppression.mockResolvedValue(result);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["quiet_hours", "not_shared_mode", "provider_error"])("never reports delivery for %s", async (reason) => {
    mocks.send.mockResolvedValue({ ok: false, reason });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "We couldn't send the text. Open the demo here instead." });
  });

  it("preserves uncertainty when the provider response was lost", async () => {
    mocks.send.mockResolvedValue({ ok: false, reason: "delivery_unknown" });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Delivery isn't confirmed. Check your phone or open the demo.", deliveryUnknown: true });
  });
});
