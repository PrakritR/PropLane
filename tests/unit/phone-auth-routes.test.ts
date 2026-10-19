import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  getUser: vi.fn(), setSession: vi.fn(), start: vi.fn(), verify: vi.fn(), enabled: vi.fn(), identity: vi.fn(),
  needsPhone: vi.fn(), profile: vi.fn(), cookieSet: vi.fn(), values: new Map<string, string>(), role: "resident",
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate, clientIpFrom: () => "203.0.113.9" }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => mocks.values.has(name) ? { value: mocks.values.get(name) } : undefined,
  set: mocks.cookieSet,
}) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/lib/supabase/server", () => {
  const client = () => ({ auth: { getUser: mocks.getUser, setSession: mocks.setSession },
    from: () => ({ select: () => ({ eq: async () => ({ data: [{ role: mocks.role }], error: null }) }) }),
  });
  return { createRealIdentitySupabaseServerClient: async () => client(), createSupabaseServerClient: async () => client() };
});
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/server-profile", () => ({ getServerSessionProfile: mocks.profile }));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager.",
  PHONE_BROWSER_COOKIE: "proplane_phone_browser", PHONE_OLD_COOKIE: "proplane_phone_old",
  newPhoneBrowserSecret: () => "new-browser-secret", startPhoneChallenge: mocks.start, verifyPhoneChallenge: mocks.verify,
  phoneAuthEnabled: mocks.enabled, readPhoneIdentity: mocks.identity, needsPhoneVerification: mocks.needsPhone,
}));

import { GET } from "@/app/api/auth/phone/route";
import { POST as start } from "@/app/api/auth/phone/start/route";
import { POST as verify } from "@/app/api/auth/phone/verify/route";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { PHONE_AUTH_ERROR } from "@/lib/auth/phone-auth.server";

const ID = "11111111-1111-4111-8111-111111111111";
function request(body: unknown, origin = "https://proplane.test") {
  return new Request("https://proplane.test/api/auth/phone/verify", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.role = "resident";
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.start.mockResolvedValue({ challengeId: ID });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.enabled.mockResolvedValue(true);
  mocks.identity.mockResolvedValue({ phone: "+12065550100", verified: true });
  mocks.needsPhone.mockResolvedValue(false);
  mocks.profile.mockResolvedValue({ user: { id: "user" }, profile: { id: "user", role: "resident" } });
});

describe("phone auth routes", () => {
  it("status does not probe session or identity when shared mode is off", async () => {
    mocks.enabled.mockResolvedValue(false);
    const response = await GET();
    expect(await response.json()).toEqual({ enabled: false, verified: false, phone: null, needsOldNumber: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("does not disclose any phone to an unauthenticated status request", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect(await (await GET()).json()).toEqual({ enabled: true, verified: false, phone: null, needsOldNumber: false });
    expect(mocks.identity).not.toHaveBeenCalled();
  });

  it("signed-in status requires old-number proof for an already verified phone", async () => {
    expect(await (await GET()).json()).toMatchObject({ verified: true, needsOldNumber: true });
    expect(mocks.identity).toHaveBeenCalledWith({}, "user");
  });

  it("starts proof bound to a server-owned HttpOnly browser cookie and actor", async () => {
    const response = await start(request({ phone: "+12065550100", purpose: "verify_phone", userId: "attacker", browser: "attacker" }));
    expect(response.status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ userId: "user", browser: "new-browser-secret" }));
    expect(mocks.cookieSet).toHaveBeenCalledWith("proplane_phone_browser", "new-browser-secret", expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict", maxAge: 600 }));
    expect(await response.json()).toEqual({ challengeId: ID });
  });

  it("limits sends per IP and for the whole endpoint, before any challenge or cookie", async () => {
    await start(request({ phone: "+12065550100", purpose: "sign_in" }));
    expect(mocks.rate.mock.calls).toEqual([
      ["phone-auth-start-ip:203.0.113.9", 5, 3_600_000],
      ["phone-auth-start-global", 300, 3_600_000],
    ]);
  });

  it.each([0, 1])("refuses with the generic message when rate bucket %s is exhausted", async (bucket) => {
    mocks.rate.mockImplementation(async () => ({ ok: mocks.rate.mock.calls.length - 1 !== bucket }));
    const response = await start(request({ phone: "+12065550100", purpose: "sign_in" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("a limiter outage refuses too (fail closed)", async () => {
    mocks.rate.mockResolvedValue({ ok: false, unavailable: true });
    expect((await start(request({ phone: "+12065550100", purpose: "sign_in" }))).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([start, verify])("rejects cross-origin writes before any proof handling", async (action) => {
    const response = await action(request({ phone: "+12065550100", purpose: "sign_in", challengeId: ID, code: "000007" }, "https://attacker.test"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects an unsupported purpose before setting a cookie", async () => {
    expect((await start(request({ purpose: "admin_reset" }))).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("a code and challenge id alone cannot replace the bound browser", async () => {
    expect((await verify(request({ challengeId: ID, code: "000007" }))).status).toBe(400);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it.each(["expired", "taken", "too_many_attempts", "database_error"])("returns the same neutral response for %s", async (reason) => {
    mocks.values.set("proplane_phone_browser", "browser");
    mocks.verify.mockRejectedValue(new Error(reason));
    const response = await verify(request({ challengeId: ID, code: "000007" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("stores old-number proof only in the bound cookie and never trusts body oldChallengeId", async () => {
    mocks.values.set("proplane_phone_browser", "browser");
    mocks.values.set("proplane_phone_old", "real-old-proof");
    mocks.verify.mockResolvedValue({ ok: true, oldNumberVerified: true });
    await verify(request({ challengeId: ID, code: "000007", oldChallengeId: "forged" }));
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ oldChallengeId: "real-old-proof" }));
    expect(mocks.cookieSet).toHaveBeenCalledWith("proplane_phone_old", ID, expect.objectContaining({ httpOnly: true }));
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("installs a checked session as cookies without returning credentials in JSON", async () => {
    mocks.values.set("proplane_phone_browser", "browser");
    const session = { access_token: "private-access", refresh_token: "private-refresh" };
    mocks.verify.mockResolvedValue({ ok: true, session });
    const response = await verify(request({ challengeId: ID, code: "000007" }));
    expect(response.status).toBe(200);
    expect(mocks.setSession).toHaveBeenCalledWith(session);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.cookieSet).toHaveBeenCalledWith("proplane_phone_old", "", expect.objectContaining({ maxAge: 0 }));
  });

  it("does not report success if cookie session installation fails", async () => {
    mocks.values.set("proplane_phone_browser", "browser");
    mocks.verify.mockResolvedValue({ ok: true, session: { access_token: "access", refresh_token: "refresh" } });
    mocks.setSession.mockResolvedValue({ error: new Error("failed") });
    const response = await verify(request({ challengeId: ID, code: "000007" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_ERROR });
  });
});

describe("server portal phone-verification gate", () => {
  it.each(["resident", "vendor", "manager", "admin"])("blocks %s portal access before returning role context", async (role) => {
    mocks.role = role;
    mocks.profile.mockResolvedValue({ user: { id: "user" }, profile: { id: "user", role } });
    mocks.needsPhone.mockResolvedValue(true);
    await expect(getPortalAccessContext()).rejects.toThrow("REDIRECT:/auth/verify-phone");
  });

  it("preserves legacy access when no phone gate applies", async () => {
    expect(await getPortalAccessContext()).toMatchObject({ user: { id: "user" }, roles: ["resident"], effectiveRole: "resident" });
  });

  it("does not call the phone gate for a signed-out request", async () => {
    mocks.profile.mockResolvedValue({ user: null, profile: null });
    expect(await getPortalAccessContext()).toMatchObject({ user: null, roles: [] });
    expect(mocks.needsPhone).not.toHaveBeenCalled();
  });

  it("a phone identity read failure cannot open a portal", async () => {
    mocks.needsPhone.mockRejectedValue(new Error("unavailable"));
    await expect(getPortalAccessContext()).rejects.toThrow("unavailable");
  });
});
