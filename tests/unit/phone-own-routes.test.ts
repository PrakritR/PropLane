// The start/verify routes serve the Settings "Verify" flow (`purpose: "verify_own_phone"`) for a signed-in user only,
// with a per-account send budget, and relay the three plain-word outcomes instead of the generic refusal.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(), getUser: vi.fn(), start: vi.fn(), verify: vi.fn(), cookieSet: vi.fn(), values: new Map<string, string>(),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, clientIpFrom: () => "203.0.113.9" }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => mocks.values.has(name) ? { value: mocks.values.get(name) } : undefined,
  set: mocks.cookieSet,
}) }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser, setSession: vi.fn() } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager.",
  PHONE_BROWSER_COOKIE: "proplane_phone_browser", PHONE_OLD_COOKIE: "proplane_phone_old",
  newPhoneBrowserSecret: () => "new-browser-secret", startPhoneChallenge: mocks.start, verifyPhoneChallenge: mocks.verify,
}));

import { POST as start } from "@/app/api/auth/phone/start/route";
import { POST as verify } from "@/app/api/auth/phone/verify/route";
import { PHONE_AUTH_ERROR } from "@/lib/auth/phone-auth.server";
import {
  PHONE_EXPIRED_CODE_MESSAGE, PHONE_TAKEN_MESSAGE, PHONE_WRONG_CODE_MESSAGE, PhoneOwnFlowError,
} from "@/lib/auth/phone-own-errors";

const ID = "11111111-1111-4111-8111-111111111111";
function request(body: unknown) {
  return new Request("https://proplane.test/api/auth/phone/start", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://proplane.test" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.values.set("proplane_phone_browser", "browser");
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.start.mockResolvedValue({ challengeId: ID });
  mocks.verify.mockResolvedValue({ ok: true });
});

describe("POST /api/auth/phone/start with verify_own_phone", () => {
  it("starts for the signed-in user and never forwards a body user id", async () => {
    const response = await start(request({ purpose: "verify_own_phone", phone: "+19995550100", userId: "attacker" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challengeId: ID });
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", purpose: "verify_own_phone" }));
  });

  it("refuses a signed-out caller before any challenge or cookie", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const response = await start(request({ purpose: "verify_own_phone" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("adds a per-account hourly send budget on top of the per-IP and endpoint-wide ones", async () => {
    await start(request({ purpose: "verify_own_phone" }));
    expect(mocks.rate.mock.calls.map((call) => call[0])).toEqual([
      "phone-auth-start-ip:203.0.113.9", "phone-auth-start-global", "phone-auth-start-user:user",
    ]);
    mocks.start.mockClear();
    mocks.rate.mockImplementation(async (key: string) => ({ ok: !key.startsWith("phone-auth-start-user:") }));
    const throttled = await start(request({ purpose: "verify_own_phone" }));
    expect(throttled.status).toBe(400);
    expect(await throttled.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("says a number verified on another account is refused", async () => {
    mocks.start.mockRejectedValue(new PhoneOwnFlowError("taken"));
    const response = await start(request({ purpose: "verify_own_phone" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_TAKEN_MESSAGE });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("keeps the generic message for every other failure", async () => {
    mocks.start.mockRejectedValue(new Error("anything else"));
    const response = await start(request({ purpose: "verify_own_phone" }));
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
  });
});

describe("POST /api/auth/phone/verify with verify_own_phone", () => {
  it("verifies as the signed-in user with the own-phone flag", async () => {
    const response = await verify(request({ purpose: "verify_own_phone", challengeId: ID, code: "000007" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", ownPhone: true }));
  });

  it("does not turn the flag on for any other request", async () => {
    await verify(request({ challengeId: ID, code: "000007" }));
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ ownPhone: false }));
  });

  it("refuses a signed-out caller", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const response = await verify(request({ purpose: "verify_own_phone", challengeId: ID, code: "000007" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong", PHONE_WRONG_CODE_MESSAGE],
    ["expired", PHONE_EXPIRED_CODE_MESSAGE],
    ["taken", PHONE_TAKEN_MESSAGE],
  ] as const)("relays the %s outcome in plain words", async (reason, message) => {
    mocks.verify.mockRejectedValue(new PhoneOwnFlowError(reason));
    const response = await verify(request({ purpose: "verify_own_phone", challengeId: ID, code: "000007" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  });

  it("keeps the generic message for every other failure", async () => {
    mocks.verify.mockRejectedValue(new Error("database_error"));
    const response = await verify(request({ purpose: "verify_own_phone", challengeId: ID, code: "000007" }));
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
  });
});
