// /api/start/<token>/send and /complete: the code goes to the link's own phone, a dead link answers like any
// other dead link, and completion needs a signed-in, verified account.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  link: null as null | Record<string, unknown>,
  start: vi.fn(async (..._a: unknown[]) => ({ challengeId: "chal-1" })),
  user: null as null | { id: string },
  finish: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, kind: "landlord", portalHref: "/portal/dashboard", draftPropertyId: "mgr-text-1", already: false }) as unknown),
  cookieSet: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: m.cookieSet }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({
  PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager.",
  PHONE_BROWSER_COOKIE: "proplane_phone_browser",
  newPhoneBrowserSecret: () => "secret",
  startPhoneChallenge: (...a: unknown[]) => m.start(...a),
}));
vi.mock("@/lib/one-number/link-http.server", () => ({
  allowLinkRequest: async () => true,
  expiredLinkResponse: () => new Response(JSON.stringify({ error: "This link has expired." }), { status: 404 }),
}));
vi.mock("@/lib/one-number/onboarding/setup-links.server", () => ({ resolveSetupLink: async () => m.link }));
vi.mock("@/lib/one-number/onboarding/finish-setup.server", () => ({ finishSetup: (...a: unknown[]) => m.finish(...a) }));

import { POST as send } from "@/app/api/start/[token]/send/route";
import { POST as complete } from "@/app/api/start/[token]/complete/route";

const ctx = { params: Promise.resolve({ token: "t".repeat(43) }) };
const req = (body: unknown = {}) => new Request("https://proplane.ai/api/start/x/send", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  m.link = { id: "L1", kind: "landlord", phoneKey: "2065550142", context: {}, invitedByWorkspaceId: null, expiresAt: "2099-01-01", waitlistedAt: null, usedAt: null, userId: null };
  m.user = null;
  m.start.mockClear();
  m.finish.mockClear();
});

describe("send", () => {
  it("texts the code to the link's own phone and ignores a phone in the body", async () => {
    const res = await send(req({ phone: "+12065559999" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeId: "chal-1" });
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ phone: "+12065550142", purpose: "sign_in", userId: null }));
    expect(m.cookieSet).toHaveBeenCalled();
  });
  it("an open web link uses the visitor's phone", async () => {
    m.link = { ...m.link!, phoneKey: null };
    await send(req({ phone: "+12065559999" }), ctx);
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ phone: "+12065559999" }));
  });
  it("a dead link answers 404 and sends nothing", async () => {
    m.link = null;
    expect((await send(req(), ctx)).status).toBe(404);
    expect(m.start).not.toHaveBeenCalled();
  });
});

describe("complete", () => {
  it("needs a signed-in account", async () => {
    expect((await complete(req(), ctx)).status).toBe(401);
    expect(m.finish).not.toHaveBeenCalled();
  });
  it("finishes for a signed-in account and never returns a redirect", async () => {
    m.user = { id: "u1" };
    const res = await complete(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: "landlord", portalHref: "/portal/dashboard", draftCreated: true, already: false });
    expect(res.headers.get("location")).toBeNull();
  });
  it.each([
    ["waitlisted", 202],
    ["phone_mismatch", 403],
    ["phone_unverified", 401],
    ["unavailable", 502],
  ])("%s -> %i", async (reason, status) => {
    m.user = { id: "u1" };
    m.finish.mockResolvedValueOnce({ ok: false, reason });
    expect((await complete(req(), ctx)).status).toBe(status);
  });
  it("a dead link is 404 before anything else", async () => {
    m.link = null;
    m.user = { id: "u1" };
    expect((await complete(req(), ctx)).status).toBe(404);
  });
});
