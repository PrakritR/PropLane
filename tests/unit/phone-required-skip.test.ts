// "Skip for now": only after a code really could not be sent, only for the current sign-in, never in shared mode.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getUser: vi.fn(), getUserById: vi.fn(), enabled: vi.fn(), required: vi.fn(), set: vi.fn(), values: new Map<string, string>(),
  /** The skip ledger and the platform-wide outage switch the cap reads. */
  skips: [] as Array<{ user_id: string; created_at: string }>,
  outage: false,
  insertError: null as { code?: string } | null,
  /** Make the rpc answer as a database without the function (code ahead of the migration). */
  rpcMissing: false,
  rpcCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (m.values.has(n) ? { value: m.values.get(n) } : undefined), set: m.set }) }));
vi.mock("@/lib/supabase/server", () => ({ createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: m.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    auth: { admin: { getUserById: m.getUserById } },
    // record_phone_required_skip: count + insert in one step (the real one runs under an advisory lock in Postgres).
    rpc: async (name: string, args: { p_user_id: string; p_cooldown_seconds: number; p_lifetime_max: number; p_enforce: boolean }) => {
      if (name !== "record_phone_required_skip") throw new Error(`unexpected rpc ${name}`);
      m.rpcCalls.push(args);
      if (m.rpcMissing) return { data: null, error: { code: "PGRST202" } };
      if (m.insertError) return { data: null, error: m.insertError };
      const mine = m.skips.filter((r) => r.user_id === args.p_user_id);
      if (args.p_enforce) {
        if (mine.length >= args.p_lifetime_max) return { data: false, error: null };
        const last = Math.max(0, ...mine.map((r) => Date.parse(r.created_at)));
        if (last && Date.now() - last < args.p_cooldown_seconds * 1000) return { data: false, error: null };
      }
      m.skips.push({ user_id: args.p_user_id, created_at: new Date().toISOString() });
      return { data: true, error: null };
    },
    from: (table: string) => {
      if (table === "sms_runtime_config") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { phone_send_outage: m.outage }, error: null }) }) }) };
      }
      if (table === "phone_required_skips") {
        const builder = {
          select: () => builder,
          eq: (_c: string, v: unknown) => { builder._user = String(v); return builder; },
          order: () => builder,
          limit: async () => ({ data: m.skips.filter((r) => r.user_id === builder._user).sort((a, b) => b.created_at.localeCompare(a.created_at)), error: null }),
          insert: async (row: { user_id: string; created_at: string }) => {
            if (m.insertError) return { error: m.insertError };
            m.skips.push(row);
            return { error: null };
          },
          _user: "",
        } as Record<string, unknown> & { _user: string };
        return builder;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneAuthEnabled: m.enabled, PHONE_AUTH_ERROR: "We couldn't verify this number. Try again or contact your manager." }));

import { POST } from "@/app/api/auth/phone/skip/route";
import * as req from "@/lib/auth/phone-required.server";

const ORIGIN = "https://proplane.test";
const call = () => POST(new Request(`${ORIGIN}/api/auth/phone/skip`, { method: "POST", headers: { origin: ORIGIN } }));

beforeEach(() => {
  vi.clearAllMocks();
  m.values.clear();
  m.skips.length = 0;
  m.outage = false;
  m.insertError = null;
  m.rpcMissing = false;
  m.rpcCalls.length = 0;
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

  it("is capped: one skip per account per 7 days, 3 in its lifetime", async () => {
    const proof = () => m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    proof();
    expect((await call()).status).toBe(200);
    expect(m.skips).toHaveLength(1);

    // A second skip the same day is refused, however the send failed.
    proof();
    expect((await call()).status).toBe(400);
    expect(m.skips).toHaveLength(1);

    // Past the cooldown it is allowed again, until the lifetime cap holds for good.
    m.skips[0]!.created_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    proof();
    expect((await call()).status).toBe(200);
    m.skips.forEach((row, index) => { row.created_at = new Date(Date.now() - (8 + index) * 24 * 60 * 60 * 1000).toISOString(); });
    proof();
    expect((await call()).status).toBe(200);
    expect(m.skips).toHaveLength(3);
    m.skips.forEach((row, index) => { row.created_at = new Date(Date.now() - (8 + index) * 24 * 60 * 60 * 1000).toISOString(); });
    proof();
    expect((await call()).status).toBe(400);
    expect(m.skips).toHaveLength(3);
  });

  it("a platform-wide send outage lifts the cap, so a real provider failure never locks everyone out", async () => {
    m.skips.push(
      { user_id: "u1", created_at: new Date().toISOString() },
      { user_id: "u1", created_at: new Date().toISOString() },
      { user_id: "u1", created_at: new Date().toISOString() },
    );
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    expect((await call()).status).toBe(400);
    m.outage = true;
    expect((await call()).status).toBe(200);
  });

  it("refuses when the skip cannot be recorded, so the cap cannot be sidestepped", async () => {
    m.insertError = { code: "23505" };
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    expect((await call()).status).toBe(400);
    expect(m.set).not.toHaveBeenCalled();
  });

  it("the cap is enforced where the row is written: a request that passed the early read is still refused by the atomic record", async () => {
    // Both parallel requests read an empty ledger (the allowance passes), but only one insert wins in the database.
    const proof = () => m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    proof();
    const allowanceSpy = vi.spyOn(req, "phoneSkipAllowance").mockResolvedValue({ allowed: true });
    expect((await call()).status).toBe(200);
    proof();
    const second = await call();
    expect(second.status).toBe(400);
    expect(m.skips).toHaveLength(1);
    expect(m.rpcCalls).toHaveLength(2);
    expect(m.rpcCalls[1]).toMatchObject({ p_user_id: "u1", p_cooldown_seconds: 7 * 24 * 3600, p_lifetime_max: 3, p_enforce: true });
    allowanceSpy.mockRestore();
  });

  it("an outage lifts the cap inside the atomic record too (p_enforce false), and still records the skip", async () => {
    m.outage = true;
    m.skips.push({ user_id: "u1", created_at: new Date().toISOString() }, { user_id: "u1", created_at: new Date().toISOString() }, { user_id: "u1", created_at: new Date().toISOString() });
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    expect((await call()).status).toBe(200);
    expect(m.rpcCalls[0]).toMatchObject({ p_enforce: false });
    expect(m.skips).toHaveLength(4);
  });

  it("a database without the function yet falls back to the plain insert instead of locking the account out", async () => {
    m.rpcMissing = true;
    m.values.set(req.PHONE_SEND_FAILED_COOKIE, req.phoneSendFailedValue("u1", Date.now())!);
    expect((await call()).status).toBe(200);
    expect(m.skips).toHaveLength(1);
  });

  it("the migration is one transaction under an advisory lock, service role only", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261020110000_phone_required_skip_atomic.sql", "utf8");
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('phone-required-skip:'/);
    expect(sql).toMatch(/revoke all on function public\.record_phone_required_skip[\s\S]*from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.record_phone_required_skip[\s\S]*to service_role/);
    expect(sql).toMatch(/create or replace function/);
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
