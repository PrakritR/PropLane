import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), get: vi.fn(), link: vi.fn(), insert: vi.fn(), send: vi.fn(), inquiry: vi.fn(), purchase: vi.fn(), property: vi.fn(), effective: vi.fn(), pin: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://example.test" }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: m.find }));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({ memoizeEffectiveApplicationProperty: () => m.effective }));
vi.mock("@/lib/send-forms", () => ({ applicationPinForLinkedForm: m.pin }));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadTourInquiryById: m.inquiry }));
vi.mock("@/lib/auth/resident-setup-token", () => ({ findApplicationForResidentSetup: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: m.rpc, auth: { admin: { createUser: m.create, getUserById: m.get, generateLink: m.link } }, from: (table: string) => ({ insert: m.insert, select: () => ({ eq: () => ({ maybeSingle: table === "manager_property_records" ? m.property : m.purchase }) }) }) }) }));
import { POST } from "@/app/api/auth/email-onboarding/start/route";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", password: "attacker-known" }) });
m.rpc.mockResolvedValue({ data: 0, error: null });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("email onboarding start", () => {
  it("does not activate an old unconfirmed account with a potentially known password", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.find.mockResolvedValue("old-user");
    m.get.mockResolvedValue({ data: { user: { id: "old-user", email_confirmed_at: null, app_metadata: {} } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: false, error: null });
    expect((await POST(request())).status).toBe(200);
    expect(m.create).not.toHaveBeenCalled(); expect(m.rpc).toHaveBeenCalledTimes(2); expect(m.link).not.toHaveBeenCalled(); expect(m.insert).not.toHaveBeenCalled();
  });
  it("mints a link for an old unconfirmed account only after guarded retirement", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: true }));
    m.find.mockResolvedValue("old-user");
    m.get.mockResolvedValue({ data: { user: { id: "old-user", email_confirmed_at: null, app_metadata: {} } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null });
    m.link.mockResolvedValue({ data: { user: { id: "old-user" }, properties: { hashed_token: "test-token", verification_type: "magiclink" } } });
    m.insert.mockResolvedValue({ error: null });
    expect((await POST(request())).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("retire_unconfirmed_email_password", { p_user_id: "old-user", p_email: "guest@example.com" });
    expect(m.rpc.mock.invocationCallOrder[1]).toBeLessThan(m.link.mock.invocationCallOrder[0]);
  });
  it("refuses to send a tour handoff for another mailbox", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.inquiry.mockResolvedValue({ email: "victim@example.com" });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1" }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.create).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled();
  });
  it("refuses a paid-manager reference owned by another email", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.purchase.mockResolvedValue({ data: { id: "purchase", email: "victim@example.com", user_id: null }, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "manager_paid", checkoutSessionId: "checkout" }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.create).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled();
  });
  it("rejects a room outside the selected property's stored listing", async () => {
    vi.stubEnv("RESEND_API_KEY", "test");
    m.property.mockResolvedValue({ data: { id: "property" }, error: null });
    m.effective.mockResolvedValue({ ok: true, property: { listingSubmission: { v: 1, rooms: [{ id: "room-1" }], bundles: [] } } });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "resident", propertyId: "property", listingRoomId: "other-room" }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.create).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled();
  });
  it("creates an unconfirmed account with a server-generated password", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: true }));
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "test-token", verification_type: "magiclink" } } }); m.insert.mockResolvedValue({ error: null });
    expect((await POST(request())).status).toBe(200);
    const created = m.create.mock.calls[0][0]; expect(created.email_confirm).toBe(false); expect(created.password).not.toBe("attacker-known");
    expect(m.link).toHaveBeenCalledWith({ type: "magiclink", email: "guest@example.com" });
    expect(m.insert).toHaveBeenCalledOnce(); expect(m.send).toHaveBeenCalledOnce();
  });
});
