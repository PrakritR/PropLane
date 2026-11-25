import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ user: vi.fn(), business: vi.fn(), prepare: vi.fn(), complete: vi.fn(), rpc: vi.fn(), roles: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: m.user } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: m.roles }) }), rpc: m.rpc }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: m.business }));
vi.mock("@/lib/lease-stay-extension.server", () => ({ prepareStayExtension: m.prepare, completeStayExtension: m.complete, StayExtensionError: class extends Error { status = 409; } }));
import { POST, PUT } from "@/app/api/manager/extend-stay/route";
const extension = { id: "ext", leaseId: "lease", checkout: "2027-02-01", chargeIds: ["charge"] };
const record = { id: "lease", manager_user_id: "resolved-owner", property_id: "house", row_data: { generatedHtml: "signed body" } };
const request = (extra = {}) => new NextRequest("http://localhost/api/manager/extend-stay", { method: "POST", body: JSON.stringify({ leaseId: "lease", checkout: "2027-02-01", token: "quote", ...extra }) });
beforeEach(() => {
  vi.resetAllMocks();
  m.user.mockResolvedValue({ data: { user: { id: "staff", email: "qa@example.invalid" } } });
  m.roles.mockResolvedValue({ data: [{ role: "manager" }], error: null });
  m.business.mockResolvedValue({ kind: "allowed" });
  m.prepare.mockResolvedValue({ record, extension, token: "quote", charges: [], expectedCharges: [], revision: 3, applicationRecord: { id: "app", row_data: {} } });
  m.rpc.mockResolvedValue({ data: extension, error: null });
  m.complete.mockResolvedValue({ delivered: 1, failed: 0 });
});
describe("extend stay route", () => {
  it("previews without any write", async () => { expect((await PUT(request())).status).toBe(200); expect(m.rpc).not.toHaveBeenCalled(); expect(m.complete).not.toHaveBeenCalled(); });
  it("uses session actor and resolved owner, ignoring a body owner or amount", async () => {
    expect((await POST(request({ managerUserId: "attacker", amount: 1, actorId: "other" }))).status).toBe(200);
    expect(m.prepare).toHaveBeenCalledWith(expect.anything(), "staff", "lease", "2027-02-01");
    expect(m.rpc).toHaveBeenCalledWith("commit_stay_extension", expect.objectContaining({ p_owner: "resolved-owner", p_actor: "staff", p_property: "house", p_extension: extension }));
  });
  it("rejects a changed quote before changing dates or charges", async () => {
    expect((await POST(request({ token: "stale" }))).status).toBe(409); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("replays a committed extension without inserting another charge", async () => {
    m.prepare.mockResolvedValue({ record, existing: extension });
    expect((await POST(request())).status).toBe(200); expect(m.rpc).not.toHaveBeenCalled(); expect(m.complete).toHaveBeenCalledOnce();
  });
  it("does not notify when the atomic commit refuses a concurrent overlap", async () => {
    m.rpc.mockResolvedValue({ error: { message: "Room is occupied" } });
    expect((await POST(request())).status).not.toBe(200); expect(m.complete).not.toHaveBeenCalled();
  });
  it("reports a saved extension with a retry requirement if ledger delivery fails", async () => {
    m.complete.mockRejectedValue(new Error("ledger unavailable"));
    const response = await POST(request()); expect(response.status).toBe(202); expect((await response.json()).retryDelivery).toBe(true);
  });
  it("refuses signed-out and resident callers", async () => {
    m.user.mockResolvedValueOnce({ data: { user: null } }); expect((await POST(request())).status).toBe(401);
    m.roles.mockResolvedValueOnce({ data: [{ role: "resident" }] }); expect((await POST(request())).status).toBe(403);
    expect(m.prepare).not.toHaveBeenCalled();
  });
});
