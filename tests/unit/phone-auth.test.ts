import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), send: vi.fn(), verifyOtp: vi.fn(), signInWithOtp: vi.fn(), createClient: vi.fn(),
}));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof import("node:crypto")>()), randomInt: () => 7 }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/auth/phone-otp-delivery.server", () => ({ sendPhoneAuthCode: mocks.send }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import {
  PHONE_AUTH_ERROR, mintPhoneSession, needsPhoneVerification, phoneBrowserHash, phoneCodeHash, readPhoneIdentity,
  startPhoneChallenge, verifyPhoneChallenge,
} from "@/lib/auth/phone-auth.server";

const PHONE = "+12065550100";
const ID = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const BROWSER = "browser-secret";
const user = { id: "user-1", email: "person@example.test", phone: PHONE, phone_confirmed_at: "2026-10-18" } as User;

function database() {
  const state = {
    profile: { phone: PHONE, phone_verified_at: "2026-10-18" } as Record<string, unknown> | null,
    challenge: { auth_user_id: null, browser_hash: phoneBrowserHash(BROWSER) } as Record<string, unknown> | null,
    proof: { id: ID, phone: PHONE, purpose: "sign_in", provider: "local" },
    owners: [user.id],
    refused: new Set<string>(),
  };
  const updates = vi.fn();
  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder),
      update: vi.fn((patch: unknown) => { updates(table, patch); return builder; }),
      maybeSingle: vi.fn(async () => ({ data: table === "profiles" ? state.profile : state.challenge, error: null })),
    };
    return builder;
  });
  const rpc = vi.fn(async (name: string, _args: unknown) => ({
    data: state.refused.has(name) ? false : name === "phone_auth_owners" ? state.owners : name === "phone_auth_consume" ? state.proof : true,
    error: null,
  }));
  const admin = {
    getUserById: vi.fn(async () => ({ data: { user }, error: null })),
    createUser: vi.fn(async () => ({ data: { user }, error: null })),
    updateUserById: vi.fn(async () => ({ data: { user }, error: null })),
    generateLink: vi.fn(async () => ({ data: { user, properties: { hashed_token: "server-only-hash" } }, error: null })),
  };
  return { state, rpc, from, updates, admin, db: { from, rpc, auth: { admin } } as unknown as SupabaseClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-hmac-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "false");
  mocks.config.mockResolvedValue({ mode: "shared" });
  mocks.send.mockResolvedValue(true);
  mocks.verifyOtp.mockResolvedValue({ data: { user, session: { user, access_token: "access", refresh_token: "refresh" } }, error: null });
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.createClient.mockReturnValue({ auth: { verifyOtp: mocks.verifyOtp, signInWithOtp: mocks.signInWithOtp } });
});
afterEach(() => vi.unstubAllEnvs());

describe("phone auth start and gate", () => {
  it("leaves existing portal access alone outside shared mode", async () => {
    const { db, from, rpc } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires verification when neither profile nor Auth has a verified phone", async () => {
    const { db, state, admin } = database();
    state.profile = null;
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    expect(await needsPhoneVerification(user.id, db)).toBe(true);
  });

  it("accepts the existing verified Auth phone while a profile is not yet linked", async () => {
    const { db, state } = database();
    state.profile = null;
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
  });

  it("preserves international country codes from Auth's digits-only phone", async () => {
    const { db, state, admin } = database();
    state.profile = null;
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: "442079460123" } }, error: null });
    expect(await readPhoneIdentity(db, user.id)).toEqual({ phone: "+442079460123", verified: true });
  });

  it("uses hosted OTP only after explicit opt-in and for an existing confirmed Auth phone", async () => {
    const { db, rpc, admin } = database();
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "true");
    await startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" });
    expect(rpc).toHaveBeenCalledWith("phone_auth_start", expect.objectContaining({ p_provider: "supabase" }));
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({ phone: PHONE, options: { shouldCreateUser: false } });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(admin.createUser).not.toHaveBeenCalled();
  });

  it("keeps legacy profile-only phone owners on the custom proof flow", async () => {
    const { db, admin } = database();
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "true");
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    await startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" });
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(PHONE, "000007", undefined);
  });

  it("reserves the challenge before sending and stores only a challenge-bound HMAC", async () => {
    const { db, rpc } = database();
    const result = await startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" });
    expect(mocks.send).toHaveBeenCalledWith(PHONE, "000007", undefined);
    expect(rpc).toHaveBeenCalledWith("phone_auth_start", expect.objectContaining({
      p_id: result.challengeId, p_code_hash: phoneCodeHash(result.challengeId, "000007"),
      p_browser_hash: phoneBrowserHash(BROWSER), p_provider: "local", p_user: null,
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('"000007"');
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
    expect(phoneCodeHash(ID, "000007")).not.toBe(phoneCodeHash(OLD, "000007"));
  });

  it.each(["+442079460958", "+4915123456789", "+8613800138000", "+2348012345678"])("refuses a non-US/CA destination %s before reserving or sending", async (phone) => {
    const { db, rpc } = database();
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone, purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a +1 number with an impossible NANP shape", async () => {
    const { db, rpc } = database();
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: "+10015550100", purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an explicit calling-code allowlist widens the destinations", async () => {
    vi.stubEnv("PHONE_AUTH_ALLOWED_CALLING_CODES", "1,44");
    const { db } = database();
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: "+442079460958", purpose: "sign_in" })).resolves.toHaveProperty("challengeId");
  });

  it("never sends when the database refuses the three-per-hour reservation", async () => {
    const { db, state } = database();
    state.refused.add("phone_auth_start");
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retires an undelivered challenge without deleting its rate-limit evidence", async () => {
    const { db, updates } = database();
    mocks.send.mockResolvedValue(false);
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(updates).toHaveBeenCalledWith("phone_otp_challenges", { consumed_at: expect.any(String) });
  });

  it("old-number proof always sends to the server-read current phone", async () => {
    const { db } = database();
    await startPhoneChallenge({ db, userId: user.id, browser: BROWSER, phone: "+12065550199", purpose: "change_number_old" });
    expect(mocks.send).toHaveBeenCalledWith(PHONE, "000007", user.id);
  });

  it("cannot use initial attach to replace an existing verified number", async () => {
    const { db, rpc } = database();
    await expect(startPhoneChallenge({ db, userId: user.id, browser: BROWSER, phone: "+12065550199", purpose: "verify_phone" })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("phone proof verification", () => {
  function verify(db: SupabaseClient, userId: string | null = null, overrides: Record<string, string> = {}) {
    return verifyPhoneChallenge({ db, userId, browser: BROWSER, challengeId: ID, code: "000007", ...overrides });
  }

  it.each(["actor", "browser"])("refuses a mismatched %s before consuming proof", async (kind) => {
    const { db, state, rpc } = database();
    state.challenge = { auth_user_id: kind === "actor" ? "other" : null, browser_hash: phoneBrowserHash(kind === "browser" ? "other" : BROWSER) };
    await expect(verify(db, user.id)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a bad code without binding or minting a session", async () => {
    const { db, state, rpc, admin } = database();
    state.refused.add("phone_auth_consume");
    await expect(verify(db)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalledWith("phone_auth_claim_operation", expect.anything());
    expect(admin.generateLink).not.toHaveBeenCalled();
  });

  it("reuses an existing verified account and mints only after binding", async () => {
    const { db, rpc, admin } = database();
    expect(await verify(db)).toMatchObject({ ok: true, session: { access_token: "access", refresh_token: "refresh" } });
    expect(admin.createUser).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("phone_auth_bind", expect.objectContaining({ p_user: user.id, p_old_id: null }));
    const bindIndex = rpc.mock.calls.findIndex(([name]) => name === "phone_auth_bind");
    expect(rpc.mock.invocationCallOrder[bindIndex]).toBeLessThan(admin.generateLink.mock.invocationCallOrder[0]);
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
  });

  it("attaches to the authenticated account without creating a login or swapping sessions", async () => {
    const { db, state, admin } = database();
    state.challenge!.auth_user_id = user.id;
    expect(await verify(db, user.id)).toEqual({ ok: true });
    expect(admin.createUser).not.toHaveBeenCalled();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });

  it("creates a new verified owner with a random internal email only after claiming the phone", async () => {
    const { db, state, rpc, admin } = database();
    state.owners = [];
    await verify(db);
    expect(admin.createUser).toHaveBeenCalledWith({
      phone: PHONE, phone_confirm: true, email_confirm: true,
      email: expect.stringMatching(/^[\da-f-]{36}@phone\.proplane\.invalid$/),
      app_metadata: { phone_only: true },
    });
    const claimIndex = rpc.mock.calls.findIndex(([name]) => name === "phone_auth_claim_operation");
    expect(rpc.mock.invocationCallOrder[claimIndex]).toBeLessThan(admin.createUser.mock.invocationCallOrder[0]);
  });

  it("rejects a hosted OTP session for an account other than the canonical phone owner", async () => {
    const { db, state, rpc, admin } = database();
    state.proof.provider = "supabase";
    mocks.verifyOtp.mockResolvedValue({ data: { user: { ...user, id: "other" }, session: { access_token: "other", refresh_token: "other" } }, error: null });
    await expect(verify(db)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalledWith("phone_auth_bind", expect.anything());
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
  });

  it.each([["other"], ["user-1", "other"]])("taken or ambiguous phones return the same neutral error: %j", async (...owners) => {
    const { db, state, rpc, admin } = database();
    state.challenge!.auth_user_id = user.id;
    state.owners = owners;
    await expect(verify(db, user.id)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(admin.updateUserById).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
  });

  it("old-number proof cannot bind or mint a session", async () => {
    const { db, state, rpc, admin } = database();
    state.challenge!.auth_user_id = user.id;
    state.proof.purpose = "change_number_old";
    expect(await verify(db, user.id)).toEqual({ ok: true, oldNumberVerified: true });
    expect(rpc).not.toHaveBeenCalledWith("phone_auth_bind", expect.anything());
    expect(admin.generateLink).not.toHaveBeenCalled();
  });

  it("passes both number proofs to the atomic binding and releases its lease", async () => {
    const { db, state, rpc } = database();
    state.challenge!.auth_user_id = user.id;
    state.proof.purpose = "change_number_new";
    await verify(db, user.id, { oldChallengeId: OLD });
    expect(rpc).toHaveBeenCalledWith("phone_auth_bind", expect.objectContaining({ p_id: ID, p_old_id: OLD }));
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
  });

  it("a refused operation lease does no provider or account work", async () => {
    const { db, state, admin } = database();
    state.refused.add("phone_auth_claim_operation");
    await expect(verify(db)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(admin.updateUserById).not.toHaveBeenCalled();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });

  it("releases an acquired operation after binding failure", async () => {
    const { db, state, rpc, admin } = database();
    state.refused.add("phone_auth_bind");
    await expect(verify(db)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });
});

describe("server-minted session identity", () => {
  it("uses an isolated client and verifies the server-only token hash", async () => {
    const { db } = database();
    await mintPhoneSession(db, user);
    expect(mocks.createClient).toHaveBeenCalledWith(expect.any(String), "test-anon", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ token_hash: "server-only-hash", type: "email" });
  });

  it("rejects a generated link for any other account before exchanging it", async () => {
    const { db, admin } = database();
    admin.generateLink.mockResolvedValue({ data: { user: { ...user, id: "other" }, properties: { hashed_token: "server-only-hash" } }, error: null });
    await expect(mintPhoneSession(db, user)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("rejects an exchanged token for another account", async () => {
    const { db } = database();
    mocks.verifyOtp.mockResolvedValue({ data: { user: { id: "other" }, session: { access_token: "wrong", refresh_token: "wrong" } }, error: null });
    await expect(mintPhoneSession(db, user)).rejects.toThrow(PHONE_AUTH_ERROR);
  });
});
