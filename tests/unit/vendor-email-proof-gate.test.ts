import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), provision: vi.fn(), find: vi.fn(), service: vi.fn(), invite: vi.fn(), claim: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.service }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: mocks.find }));
vi.mock("@/lib/auth/provision-vendor-account", () => ({ provisionVendorAccountByEmail: mocks.provision, vendorUnlinkedNotice: vi.fn(), claimVendorInvite: mocks.claim, findPendingVendorInviteByToken: mocks.invite, releaseVendorInvite: vi.fn() }));
vi.mock("@/lib/auth/account-recovery.server", () => ({ recoverySetupRedirect: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { POST } from "@/app/api/auth/vendor-register/route";

const request = () => new Request("http://localhost/api/auth/vendor-register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "victim@example.com", password: "attacker-password", phone: "+12065550100" }) });
describe("vendor signup email proof", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.service.mockReturnValue({}); });
  it("does not provision for an unauthenticated request", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("refuses a manager-accessible invite token without verified email", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const req = new Request("http://localhost/api/auth/vendor-register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "manager-accessible-token", password: "attacker-password", phone: "+12065550100" }) });
    expect((await POST(req)).status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("refuses an invite for a different verified mailbox", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "other", email: "other@example.com", email_confirmed_at: "2026-01-01" } } });
    mocks.invite.mockResolvedValue({ id: "invite", vendor_email: "victim@example.com" });
    const req = new Request("http://localhost/api/auth/vendor-register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "manager-accessible-token", phone: "+12065550100" }) });
    expect((await POST(req)).status).toBe(403);
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.provision).not.toHaveBeenCalled();
  });
  it("does not provision when the verified session has another email", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "other", email: "other@example.com", email_confirmed_at: "2026-01-01" } } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});
