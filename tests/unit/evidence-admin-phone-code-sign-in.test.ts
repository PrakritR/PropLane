// EVIDENCE HARNESS — the captain's Oct 26 decision at the HTTP door: an ADMIN account signs in with a texted code.
// The REAL `POST /api/auth/phone/verify` route runs the REAL `verifyPhoneChallenge` over a service-role fake, so the
// recorded request/response pairs are what the browser actually receives. Three doors are exercised: an admin by
// profile_roles, the primary admin email, and an account whose roles cannot be read (still refused, generically).
// Set EVIDENCE_DIR to write the transcript.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient, User } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  service: vi.fn(), getUser: vi.fn(), setSession: vi.fn(), destination: vi.fn(),
  config: vi.fn(), send: vi.fn(), verifyOtp: vi.fn(), signInWithOtp: vi.fn(), createClient: vi.fn(),
  required: vi.fn(), adminGate: vi.fn(), skip: vi.fn(),
  cookies: new Map<string, string>(), cookieSet: vi.fn(),
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: <T>(fn: T) => fn }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => (mocks.cookies.has(name) ? { value: mocks.cookies.get(name) } : undefined),
  set: mocks.cookieSet,
}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({
  createRealIdentitySupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser, setSession: mocks.setSession } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.service() }));
vi.mock("@/lib/auth/post-sign-in-destination.server", () => ({
  resolvePostSignInDestination: mocks.destination, applyPortalCookies: vi.fn(),
}));
vi.mock("node:crypto", async (original) => ({ ...(await original<typeof import("node:crypto")>()), randomInt: () => 7 }));
vi.mock("@/lib/one-number/config.server", () => ({ loadSharedLineConfig: mocks.config }));
vi.mock("@/lib/auth/phone-required.server", async (original) => ({
  ...(await original<typeof import("@/lib/auth/phone-required.server")>()),
  loadPhoneRequired: mocks.required, isAdminAccount: mocks.adminGate, phoneSkipActive: mocks.skip,
}));
vi.mock("@/lib/auth/phone-otp-delivery.server", () => ({ sendPhoneAuthCode: mocks.send }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));

import { POST as verifyRoute } from "@/app/api/auth/phone/verify/route";
import { ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION, PHONE_BROWSER_COOKIE, phoneBrowserHash } from "@/lib/auth/phone-auth.server";
import { PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

const PHONE = "+12065550100";
const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const BROWSER = "browser-secret";
const ORIGIN = "https://proplane.test";
const user = { id: "admin-1", email: "captain@example.test", phone: PHONE, phone_confirmed_at: "2026-10-18" } as User;

const transcript: string[] = [];
const say = (line: string) => void transcript.push(line);

/** The service-role fake at the SQL boundary: the real statements behind these rpcs are proved against PostgreSQL in
 * `tests/integration/profiles-phone-numeric-drift-postgres.test.ts`. */
function serviceFake(opts: { roles?: string[]; rolesError?: boolean; email?: string } = {}) {
  const audit: Record<string, unknown>[] = [];
  const authUser = { ...user, email: opts.email ?? user.email };
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder), eq: vi.fn(() => builder),
      update: vi.fn(() => builder),
      insert: vi.fn(async (row: Record<string, unknown>) => {
        if (table === "audit_log") audit.push(row);
        return { error: null };
      }),
      maybeSingle: vi.fn(async () => ({
        data: table === "profiles"
          ? { phone: PHONE, phone_verified_at: "2026-10-18" }
          : { auth_user_id: null, browser_hash: phoneBrowserHash(BROWSER) },
        error: null,
      })),
    };
    if (table === "profile_roles") {
      builder.then = (resolve: (v: unknown) => unknown) => resolve(opts.rolesError
        ? { data: null, error: { message: "read failed" } }
        : { data: (opts.roles ?? []).map((role) => ({ role })), error: null });
    }
    return builder;
  });
  const rpc = vi.fn(async (name: string) => ({
    data: name === "phone_auth_owners" ? [user.id]
      : name === "phone_auth_consume" ? { id: CHALLENGE, phone: PHONE, purpose: "sign_in", provider: "local" }
      : true,
    error: null,
  }));
  const admin = {
    getUserById: vi.fn(async () => ({ data: { user: authUser }, error: null })),
    createUser: vi.fn(async () => ({ data: { user: authUser }, error: null })),
    updateUserById: vi.fn(async () => ({ data: { user: authUser }, error: null })),
    generateLink: vi.fn(async () => ({ data: { user: authUser, properties: { hashed_token: "server-only-hash" } }, error: null })),
  };
  return { audit, db: { from, rpc, auth: { admin } } as unknown as SupabaseClient };
}

function request(body: unknown) {
  return new Request(`${ORIGIN}/api/auth/phone/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "proplane.test" },
    body: JSON.stringify(body),
  });
}

/** One signed-out phone-code sign-in, recorded the way a reviewer would read it off the network tab. */
async function signIn(label: string, fake: ReturnType<typeof serviceFake>) {
  mocks.service.mockReturnValue(fake.db);
  const body = { purpose: "sign_in", challengeId: CHALLENGE, code: "000007", next: "/portal/dashboard" };
  const response = await verifyRoute(request(body));
  const json = await response.json();
  say("");
  say(`--- ${label} ---`);
  say(`POST /api/auth/phone/verify  ${JSON.stringify(body)}`);
  say(`HTTP ${response.status}  ${JSON.stringify(json)}`);
  if (json.error) say(`the screen shows: "${json.error}"`);
  say(`session installed in the browser: ${mocks.setSession.mock.calls.length > 0 ? "yes" : "no"}`);
  say(`audit_log rows written: ${JSON.stringify(fake.audit.map((row) => ({
    action: row.action, actor_user_id: row.actor_user_id, landlord_id: row.landlord_id,
    input_summary: row.input_summary, result_summary: row.result_summary,
  })))}`);
  return { response, json: json as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.clear();
  mocks.cookies.set(PHONE_BROWSER_COOKIE, BROWSER);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-hmac-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon");
  vi.stubEnv("SUPABASE_PHONE_AUTH_HOOK_ENABLED", "false");
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.setSession.mockResolvedValue({ error: null });
  mocks.destination.mockResolvedValue({ redirectTo: "/admin", role: "admin" });
  mocks.config.mockResolvedValue({ mode: "shared" });
  mocks.required.mockResolvedValue(false);
  mocks.adminGate.mockResolvedValue(false);
  mocks.skip.mockResolvedValue(false);
  mocks.send.mockResolvedValue(true);
  mocks.verifyOtp.mockResolvedValue({ data: { user, session: { user, access_token: "access-token", refresh_token: "refresh-token" } }, error: null });
  mocks.signInWithOtp.mockResolvedValue({ error: null });
  mocks.createClient.mockReturnValue({ auth: { verifyOtp: mocks.verifyOtp, signInWithOtp: mocks.signInWithOtp } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  const out = process.env.EVIDENCE_DIR;
  if (!out || !transcript.length) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/admin-phone-code-sign-in-transcript.txt`,
    `=== POST /api/auth/phone/verify — signed-out phone-code sign-in (real route, real verifyPhoneChallenge) ===\n${transcript.join("\n")}\n`, "utf8");
});

describe("admin phone-code sign-in at the HTTP door (captain, Oct 26)", () => {
  it("an admin by profile_roles is signed in and the privileged door is audited", async () => {
    const fake = serviceFake({ roles: ["admin", "manager"] });
    const { response, json } = await signIn("admin account (profile_roles: admin, manager)", fake);
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/admin" });
    expect(mocks.setSession).toHaveBeenCalledWith({ access_token: "access-token", refresh_token: "refresh-token" });
    expect(fake.audit).toHaveLength(1);
    expect(fake.audit[0]).toMatchObject({
      action: ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION, actor_user_id: user.id, landlord_id: user.id,
      input_summary: { purpose: "sign_in", provider: "local", accountUserId: user.id },
    });
    expect(JSON.stringify(fake.audit)).not.toContain(PHONE);
  });

  it("the primary admin email is signed in with no admin role row", async () => {
    const fake = serviceFake({ email: PRIMARY_ADMIN_EMAIL });
    const { response, json } = await signIn(`primary admin email (${PRIMARY_ADMIN_EMAIL}), no role row`, fake);
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/admin" });
    expect(fake.audit).toHaveLength(1);
  });

  it("a resident signs in exactly as before, with no admin audit row", async () => {
    mocks.destination.mockResolvedValue({ redirectTo: "/resident", role: "resident" });
    const fake = serviceFake({ roles: ["resident"] });
    const { response, json } = await signIn("resident account (unchanged)", fake);
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, next: "/resident" });
    expect(fake.audit).toHaveLength(0);
  });

  it("an account whose roles cannot be read is still refused, and the screen says nothing about the number", async () => {
    const fake = serviceFake({ roles: ["admin"], rolesError: true });
    const { response, json } = await signIn("unreadable account (profile_roles read fails)", fake);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: PHONE_AUTH_COPY.generic, kind: "generic" });
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(fake.audit).toHaveLength(0);
  });
});
