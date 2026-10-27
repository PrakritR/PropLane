import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), setSession: vi.fn(), verify: vi.fn(), resend: vi.fn(), resolve: vi.fn(),
  cookieSet: vi.fn(), values: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => mocks.values.has(name) ? { value: mocks.values.get(name) } : undefined,
  set: mocks.cookieSet,
}) }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser, setSession: mocks.setSession } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ service: true }) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager.",
  PHONE_BROWSER_COOKIE: "proplane_phone_browser", PHONE_OLD_COOKIE: "proplane_phone_old",
  verifyPhoneChallenge: mocks.verify, phoneResendAllowed: mocks.resend,
}));
vi.mock("@/lib/auth/post-sign-in-destination.server", async (original) => ({
  ...(await original<typeof import("@/lib/auth/post-sign-in-destination.server")>()),
  resolvePostSignInDestination: mocks.resolve,
}));

import { POST as verify } from "@/app/api/auth/phone/verify/route";
import { PhoneAuthError, PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";

const ID = "11111111-1111-4111-8111-111111111111";
const user = { id: "user-1", email: "person@example.test" };
const session = { access_token: "a", refresh_token: "r" };
const request = (body: Record<string, unknown>) => new Request("https://proplane.test/api/auth/phone/verify", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://proplane.test" },
  body: JSON.stringify({ challengeId: ID, code: "000007", purpose: "sign_in", ...body }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.values.set("proplane_phone_browser", "browser");
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.verify.mockResolvedValue({ ok: true, session, user, created: false, phone: "+15103098345" });
  mocks.resend.mockResolvedValue(true);
  mocks.resolve.mockResolvedValue({ redirectTo: "/portal/dashboard", openedRole: null, landedRole: "manager" });
});

describe("phone verify returns where to go (straight to the portal)", () => {
  it("a single-role account gets its portal as `next`, and the portal is remembered", async () => {
    const response = await verify(request({}));
    expect(await response.json()).toEqual({ ok: true, next: "/portal/dashboard" });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ user, intendedPath: "/auth/continue" }));
    expect(response.headers.get("set-cookie")).toContain("pl_last_portal=manager");
    expect(response.headers.get("set-cookie")).not.toContain("axis_active_portal");
  });

  it("a multi-role account is opened into the remembered portal and pinned active", async () => {
    mocks.values.set("pl_last_portal", "resident");
    mocks.resolve.mockResolvedValue({ redirectTo: "/resident/dashboard", openedRole: "resident", landedRole: "resident" });
    const response = await verify(request({}));
    expect(await response.json()).toEqual({ ok: true, next: "/resident/dashboard" });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ lastPortalRole: "resident" }));
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("axis_active_portal=resident");
    expect(setCookie).toContain("pl_last_portal=resident");
  });

  it("a multi-role account with no memory is sent to the chooser, with nothing pinned", async () => {
    mocks.resolve.mockResolvedValue({ redirectTo: "/auth/choose-portal", openedRole: null, landedRole: null });
    const response = await verify(request({}));
    expect(await response.json()).toEqual({ ok: true, next: "/auth/choose-portal" });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("pl_last_portal");
  });

  it("a number with no account lands on get-started flagged as new; the resolver is not consulted", async () => {
    mocks.verify.mockResolvedValue({ ok: true, session, user, created: true, phone: "+15103098345" });
    const response = await verify(request({}));
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: true, next: "/auth/get-started?phone_new=1" });
    expect(text).not.toContain("5103098345");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("a deep link is carried through for both the resolver and a new number", async () => {
    await verify(request({ next: "/resident/communication" }));
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ intendedPath: "/resident/communication" }));
    mocks.verify.mockResolvedValue({ ok: true, session, user, created: true, phone: "+15103098345" });
    const response = await verify(request({ next: "/resident/communication" }));
    expect((await response.json()).next).toBe("/auth/get-started?phone_new=1&next=%2Fresident%2Fcommunication");
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil", "javascript:alert(1)", 42, null])("an unsafe next %j is ignored", async (next) => {
    await verify(request({ next }));
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ intendedPath: "/auth/continue" }));
  });

  it("when the resolver cannot answer, the session still stands and the form falls back to /auth/continue", async () => {
    mocks.resolve.mockRejectedValue(new Error("db down"));
    const response = await verify(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.setSession).toHaveBeenCalledWith(session);
  });

  it("does not report success if the session cannot be installed", async () => {
    mocks.setSession.mockResolvedValue({ error: new Error("x") });
    const response = await verify(request({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: PHONE_AUTH_COPY.generic, kind: "generic" });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("an expired code also says whether a fresh one would still be sent", async () => {
    mocks.verify.mockRejectedValue(new PhoneAuthError("expired", "x"));
    mocks.resend.mockResolvedValue(true);
    expect(await (await verify(request({}))).json()).toEqual({ error: PHONE_AUTH_COPY.expired, kind: "expired", canResend: true });
    mocks.resend.mockResolvedValue(false);
    expect((await (await verify(request({}))).json()).canResend).toBe(false);
  });

  it("the switch turned off before the code was checked is the off state", async () => {
    mocks.verify.mockRejectedValue(new PhoneAuthError("off", "x"));
    const response = await verify(request({}));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ phoneOff: true, kind: "off" });
  });

  it("passes the form's door hint to the server and never to a Settings flow", async () => {
    await verify(request({}));
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ signIn: true }));
    mocks.verify.mockClear();
    await verify(request({ purpose: undefined }));
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ signIn: false }));
  });
});
