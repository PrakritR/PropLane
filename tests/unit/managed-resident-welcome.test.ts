import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  scope: vi.fn(), access: vi.fn(), owner: vi.fn(), deliver: vi.fn(),
  record: null as Record<string, unknown> | null, filters: [] as unknown[][],
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "staff", email: "staff@example.invalid" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  const q = { select: () => q, eq: (key: string, value: unknown) => { m.filters.push([key, value]); return q; }, in: () => q,
    maybeSingle: async () => ({ data: { role: "manager" } }), limit: async () => ({ data: table === "manager_application_records" && m.record ? [m.record] : [] }) };
  return q;
} }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/service/service-mode.server", () => ({ loadServiceStaffScope: m.scope }));
vi.mock("@/lib/scope/settings-scope", () => ({ serviceStaffSettingsAccess: m.access }));
vi.mock("@/lib/auth/managed-application-owner.server", () => ({ resolveManagedApplicationOwner: m.owner }));
vi.mock("@/lib/manager-communication-access.server", () => ({ assertManagerCommunicationAllowedForActiveWorkspace: async () => ({ allowed: true }), communicationRefusalBody: vi.fn() }));
vi.mock("@/lib/resident-welcome.server", () => ({ RESIDENT_WELCOME_EMAIL_RE: /^[^@]+@[^@]+\.[^@]+$/, canSendResidentWelcome: () => true, deliverResidentWelcome: m.deliver }));
import { POST } from "@/app/api/portal/send-resident-welcome/route";
const send = () => POST(new Request("http://localhost/api/portal/send-resident-welcome", { method: "POST", body: JSON.stringify({ axisId: "PROPLANE-QA", to: "forged@example.invalid", residentName: "Forged", managerUserId: "forged-owner" }) }));
beforeEach(() => {
  vi.clearAllMocks(); m.filters = [];
  m.scope.mockResolvedValue({ workspaceId: "workspace", propertyIds: ["house"] });
  m.access.mockResolvedValue({ kind: "ok", ownerUserId: "owner", fullGrant: true });
  m.owner.mockResolvedValue({ ok: true, owner: "owner" });
  m.deliver.mockResolvedValue({ ok: true, id: "captured" });
  m.record = { id: "PROPLANE-QA", manager_user_id: "owner", property_id: "house", resident_email: "resident@example.invalid", row_data: { name: "QA Resident" } };
});
describe("managed staff resident welcome", () => {
  it("uses the workspace owner and persisted recipient, never body identities", async () => {
    expect((await send()).status).toBe(200);
    expect(m.filters).toContainEqual(["manager_user_id", "owner"]);
    expect(m.owner).toHaveBeenCalledWith(expect.anything(), "staff", new Set(["house"]), "owner");
    expect(m.deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "owner" }), expect.objectContaining({ to: "resident@example.invalid", residentName: "QA Resident" }));
  });
  it("refuses a staff member without a house edit grant", async () => {
    m.owner.mockResolvedValue({ ok: false, owner: null });
    expect((await send()).status).toBe(403); expect(m.deliver).not.toHaveBeenCalled();
  });
  it("refuses a missing resident instead of trusting the body", async () => {
    m.record = null; expect((await send()).status).toBe(404); expect(m.deliver).not.toHaveBeenCalled();
  });
});
