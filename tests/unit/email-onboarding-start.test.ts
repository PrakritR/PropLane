import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), get: vi.fn(), link: vi.fn(), insert: vi.fn(), send: vi.fn(), inquiry: vi.fn(), purchase: vi.fn(), invite: vi.fn(), property: vi.fn(), effective: vi.fn(), pin: vi.fn(), rpc: vi.fn(), rate: vi.fn(), capability: vi.fn(), eligible: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: (req: Request) => req.headers.get("x-test-ip") ?? "test", rateLimit: m.rate }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://example.test" }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: m.find }));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({ memoizeEffectiveApplicationProperty: () => m.effective }));
vi.mock("@/lib/send-forms", () => ({ applicationPinForLinkedForm: m.pin }));
vi.mock("@/lib/auth/provision-vendor-account", () => ({ findPendingVendorInviteByToken: m.invite }));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadTourInquiryById: m.inquiry, tourCapabilityEligible: m.eligible }));
vi.mock("@/lib/auth/resident-setup-token", () => ({ findApplicationForResidentSetup: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc: m.rpc, auth: { admin: { createUser: m.create, getUserById: m.get, generateLink: m.link } }, from: (table: string) => table === "tour_signup_capabilities" ? { select: () => { const q = { eq: () => q, is: () => q, gt: () => q, maybeSingle: m.capability }; return q; } } : ({ insert: m.insert, select: () => ({ eq: () => ({ maybeSingle: table === "manager_property_records" ? m.property : m.purchase }) }) }) }) }));
import { POST } from "@/app/api/auth/email-onboarding/start/route";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", password: "attacker-known" }) });
m.rpc.mockResolvedValue({ data: 0, error: null });
m.rate.mockResolvedValue({ ok: true });
m.eligible.mockResolvedValue(true);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe("email onboarding start", () => {
  it.each(["wrong", "expired", "reused"])("refuses a %s tour capability before account creation", async () => {
    vi.stubEnv("RESEND_API_KEY", "test");
    m.capability.mockResolvedValue({ data: null, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(410);
    expect(m.create).not.toHaveBeenCalled(); expect(m.link).not.toHaveBeenCalled();
  });
  it("offers a safe retry when a prevalidated tour claim cannot be reused", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send);
    m.capability.mockResolvedValue({ data: { id: "cap" }, error: null });
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "synthetic", verification_type: "signup" } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: false, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    const response = await POST(req);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Check your email for an existing verification link, or try again." });
    expect(m.link).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });
  it("leaves a reserved tour retryable when provider minting fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send);
    m.capability.mockResolvedValue({ data: { id: "cap" }, error: null });
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(503);
    expect(m.rpc.mock.calls.some(([name]) => name === "bind_tour_email_handoff")).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("does not send when binding the minted digest fails", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send);
    m.capability.mockResolvedValue({ data: { id: "cap" }, error: null });
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "synthetic", verification_type: "signup" } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(503);
    expect(m.link).toHaveBeenCalledOnce(); expect(m.send).not.toHaveBeenCalled();
  });
  it("atomically binds an exact tour capability to the emailed proof", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockResolvedValue({ ok: true }));
    m.capability.mockResolvedValue({ data: { id: "cap" }, error: null });
    m.find.mockResolvedValue(null); m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "synthetic", verification_type: "signup" } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("preclaim_tour_email_handoff", expect.objectContaining({ p_inquiry: "tour-1", p_email: "guest@example.com", p_user: "new-user" }));
    expect(m.rpc).toHaveBeenCalledWith("bind_tour_email_handoff", expect.objectContaining({ p_user: "new-user" }));
    expect(m.rpc.mock.invocationCallOrder[1]).toBeLessThan(m.link.mock.invocationCallOrder[0]);
    expect(m.send).toHaveBeenCalledOnce();
  });
  it("retries delivery for the same capability and Auth subject after a transport failure", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); vi.stubGlobal("fetch", m.send.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true }));
    m.capability.mockResolvedValueOnce({ data: { id: "cap", consumed_user_id: null }, error: null }).mockResolvedValueOnce({ data: { id: "cap", consumed_user_id: "new-user" }, error: null });
    m.find.mockResolvedValueOnce(null).mockResolvedValueOnce("new-user");
    m.create.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null });
    m.get.mockResolvedValue({ data: { user: { id: "new-user", email_confirmed_at: null, app_metadata: { proplane_email_onboarding: true } } } });
    m.link.mockResolvedValue({ data: { user: { id: "new-user" }, properties: { hashed_token: "synthetic", verification_type: "signup" } } });
    m.rpc.mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: 0, error: null }).mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
    const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(request())).status).toBe(503);
    expect((await POST(request())).status).toBe(200);
    expect(m.rpc.mock.calls.filter(([name]) => name === "preclaim_tour_email_handoff")).toHaveLength(2);
    expect(m.send).toHaveBeenCalledTimes(2);
  });
  it("refuses a consumed capability for a different Auth subject", async () => {
    vi.stubEnv("RESEND_API_KEY", "test");
    m.capability.mockResolvedValue({ data: { id: "cap", consumed_user_id: "old-user" }, error: null });
    m.find.mockResolvedValue("new-user");
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(410);
    expect(m.link).not.toHaveBeenCalled();
  });
  it("refuses a cancelled or changed tour before generating a link", async () => {
    vi.stubEnv("RESEND_API_KEY", "test");
    m.capability.mockResolvedValue({ data: { id: "cap" }, error: null });
    m.eligible.mockResolvedValueOnce(false);
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1", tourToken: "a".repeat(64) }) });
    expect((await POST(req)).status).toBe(410);
    expect(m.link).not.toHaveBeenCalled();
  });
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
  it("caps the same normalized recipient across different IPs without account or provider calls", async () => {
    m.rate.mockImplementation(async (key: string) => ({ ok: !key.startsWith("email-onboarding:email:") }));
    try {
      for (const ip of ["192.0.2.1", "192.0.2.2"]) {
        const response = await POST(new Request("http://localhost", { method: "POST", headers: { "x-test-ip": ip }, body: JSON.stringify({ email: " Guest@Example.com " }) }));
        expect(await response.json()).toEqual({ ok: true });
      }
      expect(m.rate).toHaveBeenCalledWith("email-onboarding:email:guest@example.com", 3, 600_000);
      expect(m.find).not.toHaveBeenCalled();
      expect(m.create).not.toHaveBeenCalled();
      expect(m.link).not.toHaveBeenCalled();
      expect(m.send).not.toHaveBeenCalled();
    } finally {
      m.rate.mockResolvedValue({ ok: true });
    }
  });
  it("returns the generic response when recipient limiting is unavailable", async () => {
    m.rate.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("unavailable"));
    const response = await POST(request());
    expect(await response.json()).toEqual({ ok: true });
    expect(m.find).not.toHaveBeenCalled();
    expect(m.link).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
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
  it("refuses a tour handoff without an invitation capability", async () => {
    vi.stubEnv("RESEND_API_KEY", "test"); m.inquiry.mockResolvedValue({ email: "victim@example.com" });
    const req = new Request("http://localhost", { method: "POST", body: JSON.stringify({ email: "guest@example.com", intent: "tour", tourInquiryId: "tour-1" }) });
    const response = await POST(req); expect(response.status).toBe(410);
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
