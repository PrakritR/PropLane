import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  required: vi.fn(), admin: vi.fn(), skip: vi.fn(),
  config: vi.fn(), send: vi.fn(), verifyOtp: vi.fn(), signInWithOtp: vi.fn(), createClient: vi.fn(),
}));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof import("node:crypto")>()), randomInt: () => 7 }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/auth/phone-required.server", async (original) => ({
  ...(await original<typeof import("@/lib/auth/phone-required.server")>()),
  loadPhoneRequired: mocks.required, isAdminAccount: mocks.admin, phoneSkipActive: mocks.skip,
}));
vi.mock("@/lib/auth/phone-otp-delivery.server", () => ({ sendPhoneAuthCode: mocks.send }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import {
  ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION, PHONE_AUTH_ERROR, mintPhoneSession, needsPhoneVerification, phoneBrowserHash,
  phoneCodeHash, readPhoneIdentity, startPhoneChallenge, verifyPhoneChallenge,
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
    roles: [] as string[],
    rolesError: false,
    refused: new Set<string>(),
  };
  const updates = vi.fn();
  const inserts = vi.fn();
  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder),
      update: vi.fn((patch: unknown) => { updates(table, patch); return builder; }),
      insert: vi.fn(async (row: unknown) => { inserts(table, row); return { error: null }; }),
      maybeSingle: vi.fn(async () => ({ data: table === "profiles" ? state.profile : state.challenge, error: null })),
      ...(table === "profile_roles"
        ? { then: (resolve: (v: unknown) => unknown) => resolve(state.rolesError ? { data: null, error: { message: "read failed" } } : { data: state.roles.map((role) => ({ role })), error: null }) }
        : {}),
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
  return { state, rpc, from, updates, inserts, admin, db: { from, rpc, auth: { admin } } as unknown as SupabaseClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-hmac-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "false");
  mocks.config.mockResolvedValue({ mode: "shared" });
  mocks.required.mockResolvedValue(false);
  mocks.admin.mockResolvedValue(false);
  mocks.skip.mockResolvedValue(false);
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

  it("gives an admin's confirmed phone the hosted OTP like anyone else (captain, Oct 26)", async () => {
    const { db, rpc, state } = database();
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "true");
    state.roles = ["admin"];
    await startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" });
    expect(rpc).toHaveBeenCalledWith("phone_auth_start", expect.objectContaining({ p_provider: "supabase" }));
    expect(mocks.signInWithOtp).toHaveBeenCalledWith({ phone: PHONE, options: { shouldCreateUser: false } });
  });

  it("keeps an unreadable account's phone off hosted OTP, so GoTrue's verify cannot mint a session past the refusal", async () => {
    const { db, rpc, state } = database();
    vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "true");
    state.rolesError = true;
    await startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" });
    expect(rpc).toHaveBeenCalledWith("phone_auth_start", expect.objectContaining({ p_provider: "local" }));
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
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

  it.each([
    ["an admin profile_roles row", (s: ReturnType<typeof database>["state"]) => { s.roles = ["resident", "admin"]; }],
    ["the legacy admin profiles.role", (s: ReturnType<typeof database>["state"]) => { s.profile = { ...s.profile, role: "admin" }; }],
  ])("signs an admin in by phone code (%s): the phone is bound and a session is minted (captain, Oct 26)", async (_name, arrange) => {
    const { db, state, rpc, admin, inserts } = database();
    arrange(state);
    expect(await verify(db)).toMatchObject({ ok: true, session: { access_token: "access", refresh_token: "refresh" } });
    expect(rpc).toHaveBeenCalledWith("phone_auth_bind", expect.objectContaining({ p_user: user.id }));
    const bindIndex = rpc.mock.calls.findIndex(([name]) => name === "phone_auth_bind");
    expect(rpc.mock.invocationCallOrder[bindIndex]).toBeLessThan(admin.generateLink.mock.invocationCallOrder[0]);
    // The privileged door leaves a trail, written before the bind, carrying no phone number.
    expect(inserts).toHaveBeenCalledWith("audit_log", expect.objectContaining({
      action: ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION, actor_user_id: user.id, landlord_id: user.id,
    }));
    expect(JSON.stringify(inserts.mock.calls)).not.toContain(PHONE);
    expect(inserts.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[bindIndex]);
  });

  it("signs in the primary admin email by phone code even with no admin role row", async () => {
    const { db, admin } = database();
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, email: PRIMARY_ADMIN_EMAIL } }, error: null });
    expect(await verify(db)).toMatchObject({ ok: true, session: { access_token: "access" } });
    expect(admin.generateLink).toHaveBeenCalled();
  });

  it("refuses a signed-out phone-code sign-in for an unreadable account: nothing bound, no session minted", async () => {
    const { db, state, rpc, admin } = database();
    state.rolesError = true;
    await expect(verify(db)).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpc).not.toHaveBeenCalledWith("phone_auth_bind", expect.anything());
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("phone_auth_release_operation", expect.anything());
  });

  it("still signs in a multi-role account (manager + resident): phone-first stays open, with no admin audit row", async () => {
    const { db, state, inserts } = database();
    state.roles = ["resident", "manager"];
    expect(await verify(db)).toMatchObject({ ok: true, session: { access_token: "access" } });
    expect(inserts).not.toHaveBeenCalled();
  });

  it("an admin who is ALREADY signed in can attach a phone", async () => {
    const { db, state } = database();
    state.roles = ["admin"];
    state.challenge!.auth_user_id = user.id;
    expect(await verify(db, user.id)).toEqual({ ok: true });
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

describe("phone_required gate (any line mode)", () => {
  const unverified = (state: ReturnType<typeof database>["state"]) => { state.profile = { phone: PHONE, phone_verified_at: null }; };

  it("on: an account without a verified phone is sent to verify, in per_workspace mode", async () => {
    const { db, state, admin } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    unverified(state);
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    expect(await needsPhoneVerification(user.id, db)).toBe(true);
  });

  it("on: a verified phone passes", async () => {
    const { db } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
  });

  it("off: no redirect for an unverified account, and nothing about the phone is read", async () => {
    const { db, state, rpc } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(false);
    unverified(state);
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("on: an admin is exempt", async () => {
    const { db, state, admin } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    mocks.admin.mockResolvedValue(true);
    unverified(state);
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
  });

  it("on: an account that skipped on its CURRENT sign-in (a code could not be sent) is let in", async () => {
    const { db, state, admin } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    mocks.skip.mockResolvedValue(true);
    unverified(state);
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
  });

  it("on: an unreadable phone state never locks an account out", async () => {
    const { db, admin } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    db.from = (() => { throw new Error("db down"); }) as never;
    admin.getUserById.mockRejectedValue(new Error("auth down"));
    expect(await needsPhoneVerification(user.id, db)).toBe(false);
  });

  it("shared mode keeps its own gate (no admin exemption, no skip)", async () => {
    const { db, state, admin } = database();
    mocks.config.mockResolvedValue({ mode: "shared" });
    mocks.admin.mockResolvedValue(true);
    mocks.skip.mockResolvedValue(true);
    unverified(state);
    admin.getUserById.mockResolvedValue({ data: { user: { ...user, phone: undefined, phone_confirmed_at: undefined } }, error: null });
    expect(await needsPhoneVerification(user.id, db)).toBe(true);
  });

  it("a signed-in account can start verification under phone_required in per_workspace mode, from the platform sender", async () => {
    const { db } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    await expect(startPhoneChallenge({ db, userId: user.id, browser: BROWSER, phone: PHONE, purpose: "verify_phone" })).resolves.toHaveProperty("challengeId");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("phone SIGN-IN still needs the shared line even when phone_required is on", async () => {
    const { db } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    await expect(startPhoneChallenge({ db, userId: null, browser: BROWSER, phone: PHONE, purpose: "sign_in" })).rejects.toThrow(PHONE_AUTH_ERROR);
  });

  it("verification off entirely (neither switch): starting is refused", async () => {
    const { db } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    await expect(startPhoneChallenge({ db, userId: user.id, browser: BROWSER, phone: PHONE, purpose: "verify_phone" })).rejects.toThrow(PHONE_AUTH_ERROR);
  });

  it("a code that cannot be sent raises the send-failed error (the only failure that offers Skip)", async () => {
    const { db } = database();
    mocks.config.mockResolvedValue({ mode: "per_workspace" });
    mocks.required.mockResolvedValue(true);
    mocks.send.mockResolvedValue(false);
    const { PhoneSendFailedError } = await import("@/lib/auth/phone-required.server");
    await expect(startPhoneChallenge({ db, userId: user.id, browser: BROWSER, phone: PHONE, purpose: "verify_phone" })).rejects.toBeInstanceOf(PhoneSendFailedError);
  });
});
