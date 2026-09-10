import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth/account-recovery.server", () => ({ pendingAccountRecovery: vi.fn(async () => null), recoverySetupRedirect: vi.fn(async () => null) }));

/**
 * POST /api/auth/register-resident-oauth — resident account creation via Google,
 * authorized by the setup token + axis id. Captain rule: a Google email that
 * DIFFERS from the application email is allowed — relink the application onto the
 * account the applicant actually controls instead of rejecting them. A matching
 * email must NOT trigger a relink.
 */

const { getUserMock, findLookup, relinkMock, provisionMock, consumeMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  findLookup: vi.fn(),
  relinkMock: vi.fn(),
  provisionMock: vi.fn(),
  consumeMock: vi.fn(),
}));

vi.mock("@/lib/auth/resident-setup-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/resident-setup-token")>();
  return {
    ...actual,
    findApplicationForResidentSetup: findLookup,
    relinkResidentSetupApplicationEmail: relinkMock,
    consumeResidentSetupTokenOnApplication: consumeMock,
  };
});
vi.mock("@/lib/auth/provision-resident-account", () => ({ provisionResidentAccountByEmail: provisionMock }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: getUserMock } }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
  }),
}));

import { POST } from "@/app/api/auth/register-resident-oauth/route";

const APP_ROW = { id: "PROPLANE-OAUTH01", email: "applied@example.com", managerUserId: "mgr-1" };

function lookup() {
  return {
    ok: true as const,
    axisId: "PROPLANE-OAUTH01",
    email: "applied@example.com",
    name: "Applicant",
    phone: "(206) 555-0142",
    propertyId: "prop-1",
    row: APP_ROW,
  };
}

function post(body: unknown) {
  return new Request("http://localhost/api/auth/register-resident-oauth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register-resident-oauth — email mismatch relink", () => {
  beforeEach(() => {
    findLookup.mockReset().mockResolvedValue(lookup());
    relinkMock.mockReset().mockImplementation(async (_db: unknown, row: typeof APP_ROW, email: string) => ({ ...row, email }));
    provisionMock.mockReset().mockResolvedValue({ ok: true, axisId: APP_ROW.id, linkedApplication: true });
    consumeMock.mockReset().mockResolvedValue(undefined);
    getUserMock.mockReset();
  });

  it("relinks the application to the different Google email instead of rejecting", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "different.google@example.com", user_metadata: {} } } });

    const res = await POST(post({ axisId: "PROPLANE-OAUTH01", token: "tok" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; relinkedEmail?: string };
    expect(body.ok).toBe(true);
    expect(body.relinkedEmail).toBe("different.google@example.com");
    expect(relinkMock).toHaveBeenCalledWith(expect.anything(), APP_ROW, "different.google@example.com");
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: "different.google@example.com", phone: "(206) 555-0142" }),
    );
  });

  it("does not relink when the Google email matches the application", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: "Applied@Example.com", user_metadata: {} } } });

    const res = await POST(post({ axisId: "PROPLANE-OAUTH01", token: "tok" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relinkedEmail?: string };
    expect(relinkMock).not.toHaveBeenCalled();
    expect(body.relinkedEmail).toBeUndefined();
  });

  it("without a setup token, provisions a clean default-deny profile instead of 403ing (first-class OAuth signup)", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "user-2", email: "brand.new@example.com", user_metadata: { full_name: "Brand New" } } },
    });
    provisionMock.mockResolvedValueOnce({ ok: true, axisId: "AX-NEW", linkedApplication: false });

    const res = await POST(post({}));
    const responseBody = (await res.json()) as { ok?: boolean; linkedApplication?: boolean; error?: string };
    expect(res.status).toBe(200);
    expect(responseBody.ok).toBe(true);
    expect(responseBody.linkedApplication).toBe(false);
    // Never looks up or relinks an application without a token — no path to
    // inheriting a stranger's application from OAuth identity alone.
    expect(findLookup).not.toHaveBeenCalled();
    expect(relinkMock).not.toHaveBeenCalled();
    expect(provisionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: "brand.new@example.com", inheritFromApplication: false }),
    );
  });

  it("without a setup token, still requires a signed-in OAuth user", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await POST(post({}));
    expect(res.status).toBe(401);
    expect(provisionMock).not.toHaveBeenCalled();
  });
});
