import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), service: vi.fn(), find: vi.fn(), sku: vi.fn(), identity: vi.fn(), ownership: vi.fn(), role: vi.fn(), notify: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.session }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.service }));
vi.mock("@/lib/co-manager-open-invite.server", () => ({ findPendingOpenInviteByToken: mocks.find, openInviteIsExpired: () => false }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: mocks.sku, ensureProfileProplaneId: mocks.identity }));
vi.mock("@/lib/auth/co-manager-invite-scope", () => ({ findPropertyIdsNotOwnedByManager: mocks.ownership }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: mocks.role }));
vi.mock("@/lib/co-manager-notification.server", () => ({ notifyCoManagerInviteAccepted: mocks.notify }));
import { POST } from "@/app/api/pro/account-links/redeem/route";
import { hashCoManagerInviteToken } from "@/lib/co-manager-invite-token";

const row = {
  id: "invite", inviter_user_id: "owner", invitee_user_id: null,
  tab_kind: "manager", inviter_axis_id: "OWNER", invitee_axis_id: null,
  assigned_property_ids: ["owned-property"], property_co_manager_permissions: {},
  status: "pending", payout_percent_for_manager: 15, created_at: "2026-09-01",
};
function db({ rotated = false, profileError = false } = {}) {
  const filters: Record<string, unknown> = {};
  const update = vi.fn();
  return {
    filters, update,
    from(table: string) {
      let claiming = false;
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { if (claiming) filters[key] = value; return query; },
        is: () => query,
        in: () => query,
        or: () => query,
        limit: () => query,
        update: (payload: unknown) => { claiming = true; update(payload); return query; },
        maybeSingle: async () => ({ data: claiming && !rotated ? { ...row, invitee_user_id: "guest", status: "accepted" } : null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(table === "profiles"
          ? { data: [{ id: "owner", email: "owner@example.com" }, { id: "guest", email: "guest@example.com" }], error: profileError ? { message: "unavailable" } : null }
          : { count: 0, error: null }).then(resolve),
      };
      return query;
    },
  };
}
const request = () => new Request("https://example.com/api/pro/account-links/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "secret-token" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: "guest" } } }) } });
  mocks.find.mockResolvedValue({ ok: true, row });
  mocks.sku.mockImplementation(async (id: string) => ({ tier: id === "owner" ? "pro" : "free" }));
  mocks.identity.mockResolvedValue({ ok: true, proplaneId: "GUEST", fullName: "Guest" });
  mocks.ownership.mockResolvedValue({ ok: true, unowned: [] });
});

describe("open-invite redemption authorization", () => {
  it("claims a Free invitee only against the checked token and property snapshot", async () => {
    const service = db(); mocks.service.mockReturnValue(service);
    expect((await POST(request())).status).toBe(200);
    expect(service.filters).toMatchObject({ invite_token_hash: hashCoManagerInviteToken("secret-token"), assigned_property_ids: JSON.stringify(row.assigned_property_ids), status: "pending" });
  });
  it("rejects a concurrent rotation without notifying an accepted invite", async () => {
    mocks.service.mockReturnValue(db({ rotated: true }));
    expect((await POST(request())).status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("rejects an owner who no longer has a paid plan", async () => {
    const service = db(); mocks.service.mockReturnValue(service);
    mocks.sku.mockResolvedValue({ tier: "free" });
    expect((await POST(request())).status).toBe(403);
    expect(service.update).not.toHaveBeenCalled();
  });
  it("fails closed when participant identity cannot be checked", async () => {
    const service = db({ profileError: true }); mocks.service.mockReturnValue(service);
    expect((await POST(request())).status).toBe(503);
    expect(service.update).not.toHaveBeenCalled();
  });
});
