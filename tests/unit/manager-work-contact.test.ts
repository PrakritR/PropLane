import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), phone: vi.fn(), email: vi.fn() }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: mocks.auth }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: mocks.phone }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveActiveManagerWorkEmail: mocks.email }));
import { GET } from "@/app/api/manager/work-contact/route";
function authorize(link: Record<string, unknown>) {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: link, error: null }) };
  const db = { from: () => query };
  mocks.auth.mockResolvedValue({ userId: "viewer", db });
  return db;
}
beforeEach(() => vi.resetAllMocks());
describe("manager work contacts", () => {
  it("rejects unrelated and pending relationships without reading any channels", async () => {
    for (const link of [
      { inviter_user_id: "stranger", invitee_user_id: "another", status: "accepted" },
      { inviter_user_id: "owner", invitee_user_id: "viewer", status: "pending" },
    ]) {
      authorize(link);
      expect((await GET(new Request("http://local/api?relationshipId=link"))).status).toBe(404);
    }
    expect(mocks.phone).not.toHaveBeenCalled();
  });
  it("reads the accepted relationship's workspace work identity", async () => {
    const db = authorize({ inviter_user_id: "owner", invitee_user_id: "viewer", workspace_id: "workspace", status: "accepted" });
    mocks.phone.mockResolvedValue("+12065550111"); mocks.email.mockResolvedValue("office@example.com");
    const response = await GET(new Request("http://local/api?relationshipId=link"));
    expect(await response.json()).toEqual({ phone: "+12065550111", email: "office@example.com" });
    expect(mocks.phone).toHaveBeenCalledWith(db, "owner", "workspace");
    expect(mocks.email).toHaveBeenCalledWith(db, "owner", "workspace");
  });
});
