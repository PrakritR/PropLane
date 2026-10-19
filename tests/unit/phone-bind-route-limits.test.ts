import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rate: vi.fn(), lookup: vi.fn(), request: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, clientIpFrom: () => "203.0.113.5" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/one-number/link-http.server", () => ({ setLinkSessionCookie: vi.fn() }));
vi.mock("@/lib/one-number/public-bind.server", () => ({
  isPublicBindKind: (v: unknown) => v === "apply" || v === "tour",
  lookupEntryCode: mocks.lookup,
  publicBindPhoneKey: (raw: unknown) => (/^\d{10}$/.test(String(raw)) ? String(raw) : null),
  requestPublicBindCode: mocks.request,
  verifyPublicBind: mocks.verify,
}));
import { POST } from "@/app/api/public/phone-bind/route";

const call = (body: object) => POST(new Request("http://x/api/public/phone-bind", { method: "POST", body: JSON.stringify({ code: "brooklyn5", kind: "apply", phone: "2065550177", ...body }) }));
const keys = () => mocks.rate.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.lookup.mockResolvedValue({ code: "BROOKLYN5", workspaceId: "ws-1", ownerUserId: "o", propertyId: "p", label: null });
  mocks.request.mockResolvedValue({ ok: true, challengeId: "c" });
  mocks.verify.mockResolvedValue({ ok: false, reason: "wrong_code" });
});

describe("POST /api/public/phone-bind rate limits", () => {
  it("send uses its own tight per-code and per-IP buckets plus a per-workspace daily cap", async () => {
    expect((await call({ action: "send" })).status).toBe(200);
    expect(mocks.rate.mock.calls).toEqual([
      ["public-bind-send-ip:203.0.113.5", 8, 3_600_000],
      ["public-bind-send-code:BROOKLYN5", 20, 3_600_000],
      ["public-bind-send-workspace:ws-1", 200, 86_400_000],
    ]);
  });

  it("verify never touches a send bucket, so guessing cannot eat the texting allowance", async () => {
    await call({ action: "verify", otp: "123456" });
    expect(keys()).toEqual(["public-bind-verify-ip:203.0.113.5", "public-bind-verify-code:BROOKLYN5"]);
    expect(keys().some((k) => k.includes("send"))).toBe(false);
  });

  it("an unknown code is a 404 and never reaches the workspace cap", async () => {
    mocks.lookup.mockResolvedValue(null);
    expect((await call({ action: "send" })).status).toBe(404);
    expect(keys().some((k) => k.includes("workspace"))).toBe(false);
  });

  it("a bad phone never spends the workspace's daily allowance", async () => {
    expect((await call({ action: "send", phone: "123" })).status).toBe(400);
    expect(keys().some((k) => k.includes("workspace"))).toBe(false);
  });

  it("the workspace daily cap refuses with the generic message and sends nothing", async () => {
    mocks.rate.mockImplementation(async (key: string) => ({ ok: !key.startsWith("public-bind-send-workspace:") }));
    const res = await call({ action: "send" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too many tries. Try again later." });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["public-bind-send-code:", "public-bind-send-ip:"])("an exhausted %s bucket refuses before any lookup or send", async (prefix) => {
    mocks.rate.mockImplementation(async (key: string) => ({ ok: !key.startsWith(prefix) }));
    expect((await call({ action: "send" })).status).toBe(429);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
