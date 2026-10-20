// "Skip for now": only after a code really could not be sent, only for the current sign-in, never in shared mode.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getUser: vi.fn(), getUserById: vi.fn(), enabled: vi.fn(), required: vi.fn(), set: vi.fn(), values: new Map<string, string>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (m.values.has(n) ? { value: m.values.get(n) } : undefined), set: m.set }) }));
vi.mock("@/lib/supabase/server", () => ({ createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: m.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ auth: { admin: { getUserById: m.getUserById } } }) }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneAuthEnabled: m.enabled, PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager." }));

import { POST } from "@/app/api/auth/phone/skip/route";
import * as req from "@/lib/auth/phone-required.server";

const ORIGIN = "https://proplane.test";
const call = () => POST(new Request(`${ORIGIN}/api/auth/phone/skip`, { method: "POST", headers: { origin: ORIGIN } }));

beforeEach(() => {
  vi.clearAllMocks();
  m.values.clear();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  m.getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
  m.getUserById.mockResolvedValue({ data: { user: { id: "u1", last_sign_in_at: "2026-10-19T10:00:00Z" } }, error: null });
  m.enabled.mockResolvedValue(false);
  vi.spyOn(req, "loadPhoneRequired").mockResolvedValue(true);
});

describe("the signed cookies", () => {
  it("the send-failed proof binds the account, expires, and cannot be forged", () => {
    const now = 1_000_000_000_000;
    const proof = req.phoneSendFailedValue("u1", now)!;
    expect(req.readPhoneSendFailed("u1", proof, now + 60_000)).toBe(true);
    expect(req.readPhoneSendFailed("u2", proof, now + 60_000)).toBe(false);
    expect(req.readPhoneSendFailed("u1", proof, now + 16 * 60_000)).toBe(false);
    expect(req.readPhoneSendFailed("u1", `${now}.forged`, now)).toBe(false);
    expect(req.readPhoneSendFailed("u1", undefined, now)).toBe(false);
  });

  it("the skip value is per account and per sign-in", () => {
    const a = req.phoneSkipValue("u1", "2026-10-19T10:00:00Z");
    expect(a).toBeTruthy();
    expect(req.phoneSkipValue("u1", "2026-10-19T10:00:00Z")).toBe(a);
    expect(req.phoneSkipValue("u1", "2026-10-19T11:00:00Z")).not.toBe(a);
    expect(req.phoneSkipValue("u2", "2026-10-19T10:00:00Z")).not.toBe(a);
  });
});

describe("POST /api/auth/phone/skip", () => {
  it("refuses without proof that a code could not be sent", async () => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(m.set).not.toHaveBeenCalled();
  });

  it("with the proof: sets a skip cookie bound to this sign-in and clears the proof", async () => {
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    const res = await call();
    expect(res.status).toBe(200);
    const skip = m.set.mock.calls.find((c) => c[0] === req.PHONE_SKIP_COOKIE);
    expect(skip?.[1]).toBe(req.phoneSkipValue("u1", "2026-10-19T10:00:00Z"));
    expect(skip?.[2]).toMatchObject({ httpOnly: true, sameSite: "lax" });
    expect(m.set.mock.calls.find((c) => c[0] === req.PHONE_SEND_FAILED_COOKIE)?.[1]).toBe("");
  });

  it("another account's proof does not work", async () => {
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("someone-else", Date.now())!);
    expect((await call()).status).toBe(400);
  });

  it("never in shared mode, never when phone_required is off, never signed out", async () => {
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    m.enabled.mockResolvedValue(true);
    expect((await call()).status).toBe(400);
    m.enabled.mockResolvedValue(false);
    vi.spyOn(req, "loadPhoneRequired").mockResolvedValue(false);
    expect((await call()).status).toBe(400);
    vi.spyOn(req, "loadPhoneRequired").mockResolvedValue(true);
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect((await call()).status).toBe(400);
    expect(m.set).not.toHaveBeenCalled();
  });

  it("a cross-site request is refused", async () => {
    const res = await POST(new Request(`${ORIGIN}/api/auth/phone/skip`, { method: "POST", headers: { origin: "https://evil.test" } }));
    expect(res.status).toBe(400);
  });
});

describe("phoneSkipActive", () => {
  const db = { auth: { admin: { getUserById: (...a: unknown[]) => m.getUserById(...a) } } } as never;

  it("honours the cookie for the same sign-in and not after the next one", async () => {
    m.values.set(req.PHONE_SKIP_COOKIE, req.phoneSkipValue("u1", "2026-10-19T10:00:00Z")!);
    expect(await req.phoneSkipActive(db, "u1")).toBe(true);
    m.getUserById.mockResolvedValue({ data: { user: { id: "u1", last_sign_in_at: "2026-10-19T12:00:00Z" } }, error: null });
    expect(await req.phoneSkipActive(db, "u1")).toBe(false);
  });

  it("no cookie, no skip", async () => {
    expect(await req.phoneSkipActive(db, "u1")).toBe(false);
  });
});
