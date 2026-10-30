import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), get: vi.fn(), link: vi.fn(), insert: vi.fn(), send: vi.fn(), inquiry: vi.fn(), purchase: vi.fn(), invite: vi.fn(), property: vi.fn(), effective: vi.fn(), pin: vi.fn(), rpc: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: m.rate }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://example.test" }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: m.find }));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({ memoizeEffectiveApplicationProperty: () => m.effective }));
vi.mock("@/lib/send-forms", () => ({ applicationPinForLinkedForm: m.pin }));
vi.mock("@/lib/auth/provision-vendor-account", () => ({ findPendingVendorInviteByToken: m.invite }));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadTourInquiryById: m.inquiry }));
vi.mock("@/lib/auth/resident-setup-token", () => ({ findApplicationForResidentSetup: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: m.rpc, auth: { admin: { createUser: m.create, getUserById: m.get, generateLink: m.link } }, from: (table: string) => ({ insert: m.insert, select: () => ({ eq: () => ({ maybeSingle: table === "manager_property_records" ? m.property : m.purchase }) }) }) }) }));
import { POST } from "@/app/api/auth/email-onboarding/start/route";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", password: "attacker-known" }) });
m.rpc.mockResolvedValue({ data: 0, error: null });
m.rate.mockResolvedValue({ ok: true });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe("email onboarding start", () => {
  it.each(["signup", "magiclink"])("emails the provider's %s verification link without client credentials or redirect", async (type) => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: true }));
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    const hash = "synthetic+/=";
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: hash, verification_type: type } } });
    m.insert.mockResolvedValue({ error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", password: "attacker-known", next: "https://attacker.invalid" }) });
    const response = await POST(req);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(m.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(m.send.mock.calls[0][1].body);
    expect(payload.text).toContain(`https://example.test/auth/confirm?token_hash=${encodeURIComponent(hash)}&type=${type}`);
    expect(JSON.stringify(payload)).not.toContain("attacker-known");
    expect(JSON.stringify(payload)).not.toContain("https://attacker.invalid");
    expect(JSON.stringify(payload)).not.toContain(m.create.mock.calls[0][0].password);
  });
  it("returns the generic response when an unknown account cannot be created", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.find.mockResolvedValue(null);
    m.create.mockResolvedValue({ data: { user: null }, error: { message: "unavailable" } });
    const response = await POST(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("returns the generic response when delivery fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: false, status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "synthetic", verification_type: "signup" } } });
    m.insert.mockResolvedValue({ error: null });
    const response = await POST(request());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(m.send).toHaveBeenCalledOnce();
  });
  it("rate limits before any account or email operation", async () => {
    m.rate.mockResolvedValueOnce({ ok: false });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(m.find).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled(); expect(m.send).not.toHaveBeenCalled();
  });
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
    const response = await POST(req); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    expect(m.create).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled();
  });
  it("does not email a vendor invite for a different mailbox", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.invite.mockResolvedValue({ id: "invite", vendor_email: "victim@example.com" });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "vendor_invite", vendorInviteToken: "token" }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.link).not.toHaveBeenCalled();
  });
  it("stores a matching vendor invite reference without copying its token", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: true }));
    m.invite.mockResolvedValue({ id: "invite-id", vendor_email: "guest@example.com" });
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "test-token", verification_type: "magiclink" } } }); m.insert.mockResolvedValue({ error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "vendor_invite", vendorInviteToken: "sensitive-invite" }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.insert).toHaveBeenCalledWith(expect.objectContaining({ intent: "vendor_invite", vendor_invite_id: "invite-id" }));
    expect(JSON.stringify(m.insert.mock.calls[0][0])).not.toContain("sensitive-invite");
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
