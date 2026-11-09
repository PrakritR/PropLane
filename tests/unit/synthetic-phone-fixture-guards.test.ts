/**
 * The test-only phone fixture writes to the DEV database, so its refusals are the product here.
 *
 * It exists because `phone_required` sends every freshly created synthetic manager to
 * `/auth/verify-phone` and no code can reach a synthetic number — so the gate is cleared as
 * fixture SETUP. That is a real write to a real profile, which is why every one of these is a
 * refusal rather than a warning: the exact DEV project, a localhost port in range, a synthetic
 * mailbox, the BROWSER's own actor, a manager role, the phone the signup typed, and an
 * unverified before-state. One column, compare-and-set, restored afterwards.
 *
 * Hermetic: no database, no browser, no network. Nothing here claims an OTP was verified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const supabase = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: supabase.createClient }));
vi.mock("../helpers/synthetic-property-e2e", () => ({
  syntheticFixtureActorId: async () => "11111111-2222-4333-8444-555555555555",
}));

const { clearManagerPhoneGate, verifySyntheticManagerPhone, withSyntheticPhoneFixtureOwnership } = await import("../helpers/synthetic-phone-verification");

const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
const ACTOR = "11111111-2222-4333-8444-555555555555";
const EMAIL = "e2e-manager-1762700000000@example.invalid";
const PHONE = "+12065550199";
let privateDir = "";

type ProfileRow = { id: string; email: string; role: string; phone: string; phone_verified_at: string | null };

function fakePage(
  url = "http://localhost:3007/auth/verify-phone?next=/portal/dashboard",
  profile = { email: EMAIL, phone: PHONE },
  over: { gotoError?: Error } = {},
) {
  return {
    url: () => url,
    goto: async () => { if (over.gotoError) throw over.gotoError; },
    request: { get: async () => ({ ok: () => true, json: async () => profile }) },
  } as never;
}

function fakeDb(row: ProfileRow | null, over: {
  authEmail?: string;
  loseFirstUpdateAck?: boolean;
  failBeforeFirstUpdate?: boolean;
  replaceWithNewerStampAfterFirstUpdate?: boolean;
  returnOffsetTimestamp?: boolean;
} = {}) {
  const updates: Array<{ patch: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  let current: Record<string, unknown> | null = row ? { ...row } : null;
  const client = {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: ACTOR, email: over.authEmail ?? EMAIL } }, error: null }) } },
    from: () => {
      let operation: "select" | "update" = "select";
      let patch: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (next: Record<string, unknown>) => { operation = "update"; patch = next; return builder; },
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        is: (key: string, value: unknown) => { filters[key] = value; return builder; },
        maybeSingle: async () => ({ data: current ? { ...current } : null, error: current ? null : { message: "no rows" } }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(() => {
          if (operation !== "update") return resolve({ data: null, error: null });
          updates.push({ patch: { ...patch }, filters: { ...filters } });
          if (!current || current.id !== filters.id || current.email !== filters.email || current.phone !== filters.phone) {
            return resolve({ data: [], error: null });
          }
          const expected = filters.phone_verified_at;
          const currentStamp = current.phone_verified_at;
          const stampMatches = expected === null ? currentStamp === null : currentStamp === expected;
          if (!stampMatches) return resolve({ data: [], error: null });
          if (updates.length === 1 && over.failBeforeFirstUpdate) return resolve({ data: null, error: { message: "write rejected" } });
          current = { ...current, ...patch };
          if (updates.length === 1 && over.replaceWithNewerStampAfterFirstUpdate) {
            current.phone_verified_at = "2026-11-10T00:00:00.000Z";
          }
          if (updates.length === 1 && over.loseFirstUpdateAck) return resolve({ data: null, error: { message: "ack lost" } });
          const returned = { ...current };
          if (over.returnOffsetTimestamp && typeof returned.phone_verified_at === "string") {
            returned.phone_verified_at = returned.phone_verified_at.replace(/\.000Z$/, "+00:00");
          }
          return resolve({ data: [returned], error: null });
        }),
      };
      return builder;
    },
  };
  return { client, updates, getCurrent: () => current };
}

const profile = (over: Partial<ProfileRow> = {}): ProfileRow =>
  ({ id: ACTOR, email: EMAIL, role: "manager", phone: PHONE, phone_verified_at: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = DEV;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  process.env.E2E_SIGNUP_EMAIL_DOMAIN = "example.invalid";
  privateDir = mkdtempSync(path.join(tmpdir(), "phone-fixture-unit-"));
  chmodSync(privateDir, 0o700);
  process.env.E2E_PRIVATE_FIXTURE_DIR = privateDir;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.E2E_SIGNUP_EMAIL_DOMAIN;
  delete process.env.E2E_PRIVATE_FIXTURE_DIR;
  if (privateDir) rmSync(privateDir, { recursive: true, force: true });
  privateDir = "";
});

describe("the synthetic phone fixture refuses anything but its own account", () => {
  it("refuses a project that is not the exact dev/test one", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://qahnczmilgptcedaqype.supabase.co";
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("exact dev/test project");
    expect(supabase.createClient).not.toHaveBeenCalled();
  });

  it("refuses anything but a localhost port in range", async () => {
    for (const url of [
      "https://prop-lane.space/auth/verify-phone",
      "http://localhost:4000/auth/verify-phone",
      "http://example.invalid:3007/auth/verify-phone",
    ]) {
      await expect(verifySyntheticManagerPhone(fakePage(url), { email: EMAIL, phone: PHONE }))
        .rejects.toThrow("localhost port from 3000 through 3014");
    }
  });

  it("refuses a mailbox that is not a run-stamped synthetic one", async () => {
    for (const email of [
      "manager2@test.proplane.local",
      "e2e-manager@test.proplane.local",
      "e2e-manager-123@test.proplane.local",
      "e2e-manager-1762700000000@gmail.com",
    ]) {
      await expect(verifySyntheticManagerPhone(fakePage(), { email, phone: PHONE }))
        .rejects.toThrow("synthetic mailbox");
    }
  });

  it("refuses a phone that is not a normalized test E.164 number", async () => {
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: "2065550199" }))
      .rejects.toThrow("normalized E.164");
  });

  it("refuses when the browser's own actor is a different mailbox", async () => {
    const { client } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(
      fakePage(undefined, { email: "someone-else@test.proplane.local", phone: PHONE }),
      { email: EMAIL, phone: PHONE },
    )).rejects.toThrow("actor is not the synthetic mailbox");
  });

  it("refuses when the browser's actor holds a different phone", async () => {
    const { client } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(
      fakePage(undefined, { email: EMAIL, phone: "+12065550000" }),
      { email: EMAIL, phone: PHONE },
    )).rejects.toThrow("not the requested synthetic number");
  });

  it.each([
    ["a mailbox the Auth user does not hold", { authEmail: "other@test.proplane.local" }, /Auth user does not match/],
  ])("refuses %s", async (_name, over, message) => {
    const { client } = fakeDb(profile(), over);
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE })).rejects.toThrow(message);
  });

  it.each([
    ["a profile that is not a manager", profile({ role: "resident" }), /only serves a manager profile/],
    ["a profile phone the signup never typed", profile({ phone: "+12065559999" }), /not the requested synthetic number/],
    ["a profile that is already verified", profile({ phone_verified_at: "2026-11-01T00:00:00.000Z" }), /already-verified profile/],
    ["a mailbox the profile does not hold", profile({ email: "other@test.proplane.local" }), /profile does not match/],
  ])("refuses %s", async (_name, row, message) => {
    const { client, updates } = fakeDb(row);
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE })).rejects.toThrow(message);
    expect(updates).toEqual([]);
  });

  it("refuses a missing profile and writes nothing", async () => {
    const { client, updates } = fakeDb(null);
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("could not read the profile");
    expect(updates).toEqual([]);
  });
});

describe("what the fixture writes, and puts back", () => {
  it("stamps only the verification column, and restores it under the same compare-and-set", async () => {
    const { client, updates } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);

    const fixture = await verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE });
    expect(fixture).toMatchObject({ userId: ACTOR, phone: PHONE });
    expect(updates).toHaveLength(1);
    // One column. No password, no role, no entitlement, not the phone itself.
    expect(Object.keys(updates[0]!.patch)).toEqual(["phone_verified_at"]);
    expect(typeof updates[0]!.patch.phone_verified_at).toBe("string");
    expect(updates[0]!.filters).toMatchObject({ id: ACTOR, email: EMAIL, phone: PHONE, phone_verified_at: null });

    await fixture.restore();
    expect(updates).toHaveLength(2);
    expect(updates[1]!.patch).toEqual({ phone_verified_at: null });
    expect(updates[1]!.filters).toMatchObject({ id: ACTOR, email: EMAIL, phone: PHONE });

    // Restoring twice is a no-op, so a helper's `finally` and a test's `finally` can both call it.
    await fixture.restore();
    expect(updates).toHaveLength(2);
  });

  it("accepts an equivalent PostgREST timestamp with a +00:00 offset", async () => {
    const { client, updates } = fakeDb(profile(), { returnOffsetTimestamp: true });
    supabase.createClient.mockReturnValue(client);
    const fixture = await verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE });
    expect(updates).toHaveLength(1);
    await fixture.restore();
    expect(updates).toHaveLength(2);
  });

  it("writes an exclusive private before-image with the attempted timestamp before mutation", async () => {
    const { client, updates } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE });
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const files = readdirSync(privateDir);
    expect(files).toHaveLength(1);
    const file = path.join(privateDir, files[0]!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ userId: ACTOR, email: EMAIL, phone: PHONE, phone_verified_at: null });
    expect(typeof manifest.attemptedVerifiedAt).toBe("string");
    expect(updates).toHaveLength(1);
  });

  it("compensates an applied write whose acknowledgement was lost", async () => {
    const { client, updates, getCurrent } = fakeDb(profile(), { loseFirstUpdateAck: true });
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("attempted write was compensated");
    expect(updates).toHaveLength(2);
    expect(getCurrent()?.phone_verified_at).toBeNull();
  });

  it("confirms the before-state when a write fails before committing", async () => {
    const { client, updates, getCurrent } = fakeDb(profile(), { failBeforeFirstUpdate: true });
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("attempted write was compensated");
    expect(updates).toHaveLength(1);
    expect(getCurrent()?.phone_verified_at).toBeNull();
  });

  it("does not overwrite a newer verification stamp during compensation", async () => {
    const { client, updates, getCurrent } = fakeDb(profile(), { replaceWithNewerStampAfterFirstUpdate: true });
    supabase.createClient.mockReturnValue(client);
    // This mode simulates a concurrent newer stamp arriving after the attempted write.
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("exact compensation could not be confirmed");
    expect(updates).toHaveLength(1);
    expect(getCurrent()?.phone_verified_at).toBe("2026-11-10T00:00:00.000Z");
  });

  it("restores the phone stamp when gate navigation fails", async () => {
    const { client, updates, getCurrent } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await expect(clearManagerPhoneGate(fakePage(undefined, undefined, { gotoError: new Error("navigation failed") }), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("navigation failed");
    expect(updates).toHaveLength(2);
    expect(getCurrent()?.phone_verified_at).toBeNull();
  });

  it("restores helper-owned phone state when later onboarding setup fails", async () => {
    const { client, updates, getCurrent } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    const fixture = await verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE });
    await expect(withSyntheticPhoneFixtureOwnership(fixture, async () => { throw new Error("onboarding failed"); }))
      .rejects.toThrow("onboarding failed");
    expect(updates).toHaveLength(2);
    expect(getCurrent()?.phone_verified_at).toBeNull();
  });

  it("fails closed before mutation when the private before-image directory is missing", async () => {
    delete process.env.E2E_PRIVATE_FIXTURE_DIR;
    const { client, updates } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("absolute private before-image directory");
    expect(updates).toEqual([]);
  });

  it("refuses a non-private before-image directory without writing", async () => {
    chmodSync(privateDir, 0o755);
    const { client, updates } = fakeDb(profile());
    supabase.createClient.mockReturnValue(client);
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("private real directory");
    expect(updates).toEqual([]);
  });

  it("refuses to run without the dev/test service-role key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("service-role key");
  });
});
