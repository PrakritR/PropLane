import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/auth/resident-setup — the token-gated resident account creation path.
 * Captain rule: phone is REQUIRED and confirmed here, then persisted onto the
 * profile via provisioning. Missing/invalid phone must 400 before any account is
 * created.
 */

const { findLookup, provisionMock, consumeMock, createUserMock, getUserMock } = vi.hoisted(() => ({
  findLookup: vi.fn(),
  provisionMock: vi.fn(),
  consumeMock: vi.fn(),
  createUserMock: vi.fn(),
  getUserMock: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: getUserMock } }) }));

// `after()` runs the deferred SMS intro outside a request scope in tests — no-op it.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

vi.mock("@/lib/auth/resident-setup-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/resident-setup-token")>();
  return {
    ...actual,
    findApplicationForResidentSetup: findLookup,
    consumeResidentSetupTokenOnApplication: consumeMock,
  };
});
vi.mock("@/lib/auth/provision-resident-account", () => ({ provisionResidentAccountByEmail: provisionMock }));
vi.mock("@/lib/claw-onboarding-sms.server", () => ({ sendResidentPropLaneAssistantIntro: vi.fn() }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: vi.fn() }));
vi.mock("@/lib/auth/verify-auth-password", () => ({ assertPasswordMatchesExistingAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    auth: { admin: { createUser: createUserMock } },
    from: () => ({
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
  }),
}));

import { POST } from "@/app/api/auth/resident-setup/route";

const LOOKUP_OK = {
  ok: true as const,
  axisId: "PROPLANE-SETUP01",
  email: "sam@example.com",
  name: "Sam Ortiz",
  phone: "(206) 555-0142",
  propertyId: "prop-1",
  row: { id: "PROPLANE-SETUP01", email: "sam@example.com", managerUserId: "mgr-1" },
};

function post(body: unknown) {
  return new Request("http://localhost/api/auth/resident-setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/resident-setup — phone required", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    findLookup.mockReset().mockResolvedValue(LOOKUP_OK);
    provisionMock.mockReset().mockResolvedValue({ ok: true, axisId: LOOKUP_OK.axisId, linkedApplication: true });
    consumeMock.mockReset().mockResolvedValue(undefined);
    createUserMock.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    getUserMock.mockReset().mockResolvedValue({ data: { user: { id: "user-1", email: "sam@example.com", email_confirmed_at: "2026-10-30T00:00:00Z" } } });
  });

  it("400s when phone is missing", async () => {
    const res = await POST(
      post({ email: "sam@example.com", password: "hunter2hunter", token: "tok", axisId: "PROPLANE-SETUP01" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/phone/i);
    expect(createUserMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
  });
  it("does not turn a guest draft token into verified email under identity rollout", async () => {
    vi.stubEnv("RESIDENT_IDENTITY_ENABLED", "true");
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await POST(post({ email: "sam@example.com", password: "hunter2hunter", phone: "2065550142", token: "tok", axisId: "PROPLANE-SETUP01" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EMAIL_VERIFICATION_REQUIRED" });
    expect(createUserMock).not.toHaveBeenCalled();
    expect(provisionMock).not.toHaveBeenCalled();
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it("400s when phone is unparseable", async () => {
    const res = await POST(
      post({ email: "sam@example.com", password: "hunter2hunter", phone: "123", token: "tok", axisId: "PROPLANE-SETUP01" }),
    );
    expect(res.status).toBe(400);
    expect(provisionMock).not.toHaveBeenCalled();
  });

  it("provisions the already verified session with the normalized phone", async () => {
    const res = await POST(
      post({
        email: "sam@example.com",
        password: "hunter2hunter",
        phone: "(206) 555-0142",
        fullName: "Sam Ortiz",
        token: "tok",
        axisId: "PROPLANE-SETUP01",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; redirectTo?: string };
    expect(body.ok).toBe(true);
    expect(createUserMock).not.toHaveBeenCalled();
    expect(body.redirectTo).toContain("/resident/applications");
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", email: "sam@example.com", phone: "+12065550142" }),
    );
  });
});
