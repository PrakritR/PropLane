// Settings > Profile > Phone "Verify" (`purpose: "verify_own_phone"`): a SIGNED-IN person proves the number already
// saved on their own profile. It must work with the shared-line switch AND phone_required both OFF, take the number
// from the session user's profile (never the request), say the three outcomes in plain words, and leave every other
// door's switch behaviour exactly as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  required: vi.fn(), admin: vi.fn(), skip: vi.fn(), config: vi.fn(), send: vi.fn(),
}));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof import("node:crypto")>()), randomInt: () => 7 }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/auth/phone-required.server", async (original) => ({
  ...(await original<typeof import("@/lib/auth/phone-required.server")>()),
  loadPhoneRequired: mocks.required, isAdminAccount: mocks.admin, phoneSkipActive: mocks.skip,
}));
vi.mock("@/lib/auth/phone-otp-delivery.server", () => ({ sendPhoneAuthCode: mocks.send }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

import {
  PHONE_AUTH_ERROR, phoneBrowserHash, startPhoneChallenge, verifyPhoneChallenge,
} from "@/lib/auth/phone-auth.server";
import {
  PHONE_EXPIRED_CODE_MESSAGE, PHONE_TAKEN_MESSAGE, PHONE_WRONG_CODE_MESSAGE, PhoneOwnFlowError,
} from "@/lib/auth/phone-own-errors";

const OWN = "+15103098345";
const ID = "11111111-1111-4111-8111-111111111111";
const BROWSER = "browser-secret";
const ME = "user-me";
const OTHER = "user-other";
const me = { id: ME, email: "me@example.test", phone: null, phone_confirmed_at: null, user_metadata: {} } as unknown as User;

function database(overrides: { profile?: Record<string, unknown> | null; owners?: string[]; challenge?: Record<string, unknown> } = {}) {
  const state = {
    profile: overrides.profile === undefined ? { phone: "(510) 309-8345", phone_verified_at: null } : overrides.profile,
    owners: overrides.owners ?? [],
    challenge: {
      auth_user_id: ME, browser_hash: phoneBrowserHash(BROWSER), purpose: "sign_in", phone_e164: OWN,
      expires_at: new Date(Date.now() + 600_000).toISOString(), consumed_at: null, attempts: 0,
      ...(overrides.challenge ?? {}),
    } as Record<string, unknown>,
    consume: { id: ID, phone: OWN, purpose: "sign_in", provider: "local" } as unknown,
  };
  const from = vi.fn((table: string) => {
    const builder = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder), update: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({ data: table === "profiles" ? state.profile : state.challenge, error: null })),
    };
    return builder;
  });
  const rpc = vi.fn(async (name: string) => ({
    data: name === "phone_auth_owners" ? state.owners : name === "phone_auth_consume" ? state.consume : true,
    error: null,
  }));
  const admin = {
    getUserById: vi.fn(async () => ({ data: { user: me }, error: null })),
  };
  return { state, rpc, from, db: { from, rpc, auth: { admin } } as unknown as SupabaseClient };
}

const rpcNames = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-hmac-key");
  vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "false");
  // BOTH rollout switches OFF: no shared line, phone_required off.
  mocks.config.mockResolvedValue({ mode: "per_workspace" });
  mocks.required.mockResolvedValue(false);
  mocks.admin.mockResolvedValue(false);
  mocks.skip.mockResolvedValue(false);
  mocks.send.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("verify_own_phone start, both switches off", () => {
  it("texts a code to the session user's OWN saved phone, whatever number the request names", async () => {
    const { db, rpc } = database();
    const result = await startPhoneChallenge({
      db, userId: ME, browser: BROWSER, phone: "+19995550100", purpose: "verify_own_phone",
    });
    expect(result.challengeId).toMatch(/^[\da-f-]{36}$/);
    expect(rpc).toHaveBeenCalledWith("phone_auth_start", expect.objectContaining({
      p_phone: OWN, p_purpose: "sign_in", p_user: ME,
    }));
    expect(mocks.send).toHaveBeenCalledWith(OWN, "000007", ME);
  });

  it("refuses an unauthenticated caller before any send", async () => {
    const { db, rpc } = database();
    await expect(startPhoneChallenge({
      db, userId: null, browser: BROWSER, phone: OWN, purpose: "verify_own_phone",
    })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpcNames(rpc)).not.toContain("phone_auth_start");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses with the 'another account' message when the number is verified on someone else, and sends nothing", async () => {
    const { db, rpc } = database({ owners: [OTHER] });
    const attempt = startPhoneChallenge({ db, userId: ME, browser: BROWSER, phone: OWN, purpose: "verify_own_phone" });
    await expect(attempt).rejects.toBeInstanceOf(PhoneOwnFlowError);
    await expect(attempt).rejects.toThrow(PHONE_TAKEN_MESSAGE);
    expect(PHONE_TAKEN_MESSAGE).toBe("This number is verified on another account.");
    expect(rpcNames(rpc)).not.toContain("phone_auth_start");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a number that only I own is not 'taken'", async () => {
    const { db } = database({ owners: [ME] });
    await expect(startPhoneChallenge({ db, userId: ME, browser: BROWSER, phone: OWN, purpose: "verify_own_phone" }))
      .resolves.toHaveProperty("challengeId");
  });

  it("refuses an account whose phone is already verified", async () => {
    const { db } = database({ profile: { phone: OWN, phone_verified_at: "2026-10-18" } });
    await expect(startPhoneChallenge({ db, userId: ME, browser: BROWSER, phone: OWN, purpose: "verify_own_phone" }))
      .rejects.toThrow(PHONE_AUTH_ERROR);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("every OTHER purpose keeps its switch behaviour: refused while both switches are off", async () => {
    for (const purpose of ["sign_in", "verify_phone", "change_number_new"] as const) {
      const { db, rpc } = database();
      await expect(startPhoneChallenge({ db, userId: ME, browser: BROWSER, phone: OWN, purpose }))
        .rejects.toThrow(PHONE_AUTH_ERROR);
      expect(rpcNames(rpc)).not.toContain("phone_auth_start");
    }
  });
});

describe("verify_own_phone verify, both switches off", () => {
  const verify = (db: SupabaseClient, extra: Partial<Parameters<typeof verifyPhoneChallenge>[0]> = {}) =>
    verifyPhoneChallenge({ db, userId: ME, browser: BROWSER, challengeId: ID, code: "000007", ownPhone: true, ...extra });

  it("binds the saved phone for the signed-in user", async () => {
    const { db, rpc } = database();
    await expect(verify(db)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("phone_auth_bind", expect.objectContaining({ p_user: ME, p_id: ID }));
  });

  it("without the own-phone flag the same call is still refused while both switches are off", async () => {
    const { db, rpc } = database();
    await expect(verify(db, { ownPhone: false })).rejects.toThrow(PHONE_AUTH_ERROR);
    expect(rpcNames(rpc)).not.toContain("phone_auth_consume");
  });

  it("a wrong code says so", async () => {
    const { db, state } = database();
    state.consume = null;
    const attempt = verify(db);
    await expect(attempt).rejects.toBeInstanceOf(PhoneOwnFlowError);
    await expect(attempt).rejects.toThrow(PHONE_WRONG_CODE_MESSAGE);
    expect(PHONE_WRONG_CODE_MESSAGE).toBe("That code didn't match. Try again.");
  });

  it.each([
    ["past its time", { expires_at: new Date(Date.now() - 1000).toISOString() }],
    ["already spent or replaced", { consumed_at: new Date().toISOString() }],
    ["out of attempts", { attempts: 5 }],
  ])("a code that is %s says it expired, without spending another attempt", async (_label, challenge) => {
    const { db, rpc } = database({ challenge });
    const attempt = verify(db);
    await expect(attempt).rejects.toBeInstanceOf(PhoneOwnFlowError);
    await expect(attempt).rejects.toThrow(PHONE_EXPIRED_CODE_MESSAGE);
    expect(PHONE_EXPIRED_CODE_MESSAGE).toBe("That code expired. Send a new one.");
    expect(rpcNames(rpc)).not.toContain("phone_auth_consume");
  });

  it("a number that became verified on another account meanwhile is refused and never bound", async () => {
    const { db, rpc } = database({ owners: [OTHER] });
    await expect(verify(db)).rejects.toThrow(PHONE_TAKEN_MESSAGE);
    expect(rpcNames(rpc)).not.toContain("phone_auth_bind");
  });

  it("refuses an unauthenticated caller, another user's challenge, a sign-in code and a stale phone", async () => {
    await expect(verify(database().db, { userId: null })).rejects.toThrow(PHONE_AUTH_ERROR);
    await expect(verify(database({ challenge: { auth_user_id: OTHER } }).db)).rejects.toThrow(PHONE_AUTH_ERROR);
    await expect(verify(database({ challenge: { auth_user_id: null } }).db)).rejects.toThrow(PHONE_AUTH_ERROR);
    await expect(verify(database({ challenge: { purpose: "change_number_new" } }).db)).rejects.toThrow(PHONE_AUTH_ERROR);
    // The challenge was for a number that is no longer the one saved on the profile.
    await expect(verify(database({ challenge: { phone_e164: "+19995550100" } }).db)).rejects.toThrow(PHONE_AUTH_ERROR);
  });
});
