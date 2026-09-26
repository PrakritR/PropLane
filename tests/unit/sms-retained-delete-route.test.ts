import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPortalAccessContext: vi.fn(),
  fetchDetail: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.getPortalAccessContext,
  hasRole: () => true,
  hasAdminRole: () => false,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/lib/sms/sms-projection-inbox.server", () => ({
  fetchManagerSmsProjectionDetail: mocks.fetchDetail,
}));

import { DELETE } from "@/app/api/manager/sms-conversations/route";

const projectionId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const request = (body: object) => new Request("http://localhost/api/manager/sms-conversations", {
  method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

describe("retained SMS projection deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPortalAccessContext.mockResolvedValue({ user: { id: ownerId }, profile: {} });
    mocks.fetchDetail.mockResolvedValue({ resident: { projectionId, ownerManagerUserId: ownerId, phone: null } });
    mocks.rpc.mockResolvedValue({ data: 1, error: null });
  });

  it("deletes an authorized projection with no phone using the owner from scoped detail", async () => {
    const response = await DELETE(request({ projectionId }));
    expect(response.status).toBe(200);
    expect(mocks.fetchDetail).toHaveBeenCalledWith(expect.anything(), ownerId, projectionId, null, "delete");
    expect(mocks.rpc).toHaveBeenCalledWith("delete_sms_projection_conversation", {
      p_owner: ownerId, p_conversation: projectionId, p_actor: ownerId,
    });
  });

  it("refuses a viewer without the delete grant", async () => {
    mocks.fetchDetail.mockResolvedValue(null);
    expect((await DELETE(request({ projectionId }))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("preserves the phone requirement for legacy deletion", async () => {
    expect((await DELETE(request({ conversationKey: "legacy" }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
