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

const supabase = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: supabase.createClient }));
vi.mock("../helpers/synthetic-property-e2e", () => ({
  syntheticFixtureActorId: async () => "11111111-2222-4333-8444-555555555555",
}));

const { verifySyntheticManagerPhone } = await import("../helpers/synthetic-phone-verification");

const DEV = "https://emstjswhotsnyksqhqyf.supabase.co";
const ACTOR = "11111111-2222-4333-8444-555555555555";
const EMAIL = "e2e-manager-1762700000000@test.proplane.local";
const PHONE = "+12065550199";

type ProfileRow = { id: string; email: string; role: string; phone: string; phone_verified_at: string | null };

function fakePage(url = "http://localhost:3007/auth/verify-phone?next=/portal/dashboard", profile = { email: EMAIL, phone: PHONE }) {
  return {
    url: () => url,
    request: { get: async () => ({ ok: () => true, json: async () => profile }) },
  } as never;
}

function fakeDb(row: ProfileRow | null, over: { authEmail?: string; updateRows?: Array<Record<string, unknown>>; updateError?: unknown } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    auth: { admin: { getUserById: async () => ({ data: { user: { id: ACTOR, email: over.authEmail ?? EMAIL } }, error: null }) } },
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (patch: Record<string, unknown>) => { updates.push(patch); return builder; },
        eq: () => builder,
        is: () => builder,
        maybeSingle: async () => ({ data: row, error: row ? null : { message: "no rows" } }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: over.updateRows ?? [{ id: ACTOR, phone_verified_at: updates.at(-1)?.phone_verified_at ?? null }], error: over.updateError ?? null }).then(resolve),
      };
      return builder;
    },
  };
  return { client, updates };
}

const profile = (over: Partial<ProfileRow> = {}): ProfileRow =>
  ({ id: ACTOR, email: EMAIL, role: "manager", phone: PHONE, phone_verified_at: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = DEV;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  delete process.env.E2E_SIGNUP_EMAIL_DOMAIN;
  delete process.env.E2E_PRIVATE_FIXTURE_DIR;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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
    expect(Object.keys(updates[0]!)).toEqual(["phone_verified_at"]);
    expect(typeof updates[0]!.phone_verified_at).toBe("string");

    await fixture.restore();
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ phone_verified_at: null });

    // Restoring twice is a no-op, so a helper's `finally` and a test's `finally` can both call it.
    await fixture.restore();
    expect(updates).toHaveLength(2);
  });

  it("reports a conflict rather than leaving a verified flag behind", async () => {
    const { client } = fakeDb(profile(), { updateRows: [{ id: ACTOR, phone_verified_at: "kept" }] });
    supabase.createClient.mockReturnValue(client);
    // The compare-and-set on the way IN must also see its own value back.
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("could not compare-and-set");
  });

  it("refuses to run without the dev/test service-role key", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(verifySyntheticManagerPhone(fakePage(), { email: EMAIL, phone: PHONE }))
      .rejects.toThrow("service-role key");
  });
});
