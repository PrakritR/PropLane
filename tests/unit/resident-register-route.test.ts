import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ user: vi.fn(), provision: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: m.user } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: async () => null }));
vi.mock("@/lib/auth/provision-resident-account", () => ({ provisionResidentAccountByEmail: m.provision }));
vi.mock("@/lib/auth/schedule-resident-setup-link", () => ({ scheduleResidentSetupLinkEmail: vi.fn() }));
import { POST } from "@/app/api/auth/resident-register/route";

function req(body: unknown): Request {
  return new Request("http://localhost/api/auth/resident-register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/resident-register", () => {
  beforeEach(() => { vi.clearAllMocks(); m.user.mockResolvedValue({ data: { user: null } }); });
  it("rejects an invalid email", async () => {
    const res = await POST(req({ email: "not-an-email", phone: "2065550100", password: "abcdefgh" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/valid email/i);
  });

  it("rejects a missing phone", async () => {
    const res = await POST(req({ email: "new@example.com", phone: "", password: "abcdefgh" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/phone/i);
  });

  it.each([null, { id: "u1", email: "new@example.com" }, { id: "u1", email: "other@example.com", email_confirmed_at: "confirmed" }])("requires a verified matching session", async (user) => {
    m.user.mockResolvedValue({ data: { user } });
    const res = await POST(req({ email: "new@example.com", phone: "2065550100" }));
    expect(res.status).toBe(403); expect(m.provision).not.toHaveBeenCalled();
  });

  it("provisions only the verified session user without inheriting an application", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "u1", email: "new@example.com", email_confirmed_at: "confirmed" } } });
    m.provision.mockResolvedValue({ ok: true, axisId: "axis", linkedApplication: false });
    const res = await POST(req({ email: "new@example.com", phone: "2065550100" }));
    expect(res.status).toBe(200);
    expect(m.provision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "u1", email: "new@example.com", emailProven: true, inheritFromApplication: false }));
  });
});
