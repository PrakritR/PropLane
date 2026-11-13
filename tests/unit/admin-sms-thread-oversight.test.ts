/**
 * Admin Communication lists every PropLane Service workspace's texts, but opening one went through the manager
 * thread route scoped to the admin's OWN workspace, so a managed client's thread answered 404 and the pane spun
 * forever (production, Nov 12). The route now reads such a thread under the admin list's own owner scope, and only
 * when the request asks for oversight AND the caller holds the admin role.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  admin: true,
  manager: true,
  selection: vi.fn(async (..._args: unknown[]) => "11111111-1111-1111-1111-111111111111" as string | null),
  detail: vi.fn(async (..._args: unknown[]) => ({ messages: [], resident: { projectionId: "x" } }) as unknown),
  scope: vi.fn(async () => ({ fullOwnerIds: ["svc"], clientOwnerIds: ["client"], serviceWorkspaceIds: ["ws"] })),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(async () => ({ user: { id: "admin-1" } })),
  hasAdminRole: vi.fn(() => hoisted.admin),
  hasRole: vi.fn(() => hoisted.manager),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => hoisted.admin) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/sms/sms-projection-inbox.server", () => ({
  decodeSmsProjectionCursor: () => null,
  fetchManagerSmsProjectionDetail: hoisted.detail,
  resolveManagerSmsProjectionSelection: hoisted.selection,
}));
vi.mock("@/lib/sms/sms-projection.server", () => ({ updateSmsProjectionViewState: vi.fn() }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ loadAdminSmsOwnerScope: hoisted.scope }));

async function get(query: string) {
  const { GET } = await import("@/app/api/manager/sms-conversations/[id]/route");
  const id = "c49d02b1-7e99-4484-9986-b3b4550c3519:prospect:+12065550101";
  return GET(new Request(`http://localhost/api/manager/sms-conversations/${encodeURIComponent(id)}${query}`), {
    params: Promise.resolve({ id }),
  } as never);
}

describe("admin thread read", () => {
  beforeEach(() => {
    hoisted.admin = true;
    hoisted.manager = true;
    hoisted.selection.mockClear();
    hoisted.detail.mockClear();
    hoisted.scope.mockClear();
  });

  it("reads under the admin list's scope when the admin asks for oversight", async () => {
    const res = await get("?oversight=admin");
    expect(res.status).toBe(200);
    expect(hoisted.scope).toHaveBeenCalledTimes(1);
    const adminScope = await hoisted.scope.mock.results[0]!.value;
    expect(hoisted.selection.mock.calls[0]![3]).toEqual(adminScope);
    expect(hoisted.detail.mock.calls[0]![6]).toEqual(adminScope);
  });

  it("keeps an admin's own manager portal scoped to their workspace without the parameter", async () => {
    await get("");
    expect(hoisted.scope).not.toHaveBeenCalled();
    expect(hoisted.selection.mock.calls[0]![3]).toBeNull();
    expect(hoisted.detail.mock.calls[0]![6]).toBeNull();
  });

  it("never widens a non-admin who sends the parameter", async () => {
    hoisted.admin = false;
    await get("?oversight=admin");
    expect(hoisted.scope).not.toHaveBeenCalled();
    expect(hoisted.detail.mock.calls[0]![6]).toBeNull();
  });
});
