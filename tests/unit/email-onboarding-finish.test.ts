import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ getUser: vi.fn(), claim: vi.fn(), application: vi.fn(), purchase: vi.fn(), invite: vi.fn(), provision: vi.fn(), inquiry: vi.fn(), tour: vi.fn(), updates: [] as unknown[] }));
vi.mock("@/lib/tour-resident-link.server", () => ({ loadTourInquiryById: m.inquiry, linkTourInquiryToResident: m.tour }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: m.getUser } }) }));
vi.mock("@/lib/auth/verified-resident-handoff.server", () => ({ provisionVerifiedResidentHandoff: m.provision }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (name: string) => (name === "manager_application_records" || name === "manager_purchases" || name === "vendor_invites") ? { select: () => ({ eq: () => ({ maybeSingle: name === "manager_purchases" ? m.purchase : name === "vendor_invites" ? m.invite : m.application }) }) } : { update: (value: unknown) => { m.updates.push(value); const q = { eq: () => q, gt: () => q, select: () => q, maybeSingle: m.claim, then: (resolve: (x: unknown) => void) => resolve({ error: null }) }; return q; }, select: () => { const q = { eq: () => q, gt: () => q, maybeSingle: m.claim }; return q; } } }) }));
import { POST } from "@/app/api/auth/email-onboarding/finish/route";
const request = () => new Request("http://localhost", { method: "POST", body: JSON.stringify({ tokenHash: "one-time-token" }) });
describe("email onboarding completion", () => {
  beforeEach(() => { vi.clearAllMocks(); m.updates.length = 0; m.getUser.mockResolvedValue({ data: { user: { id: "resident", email: "owner@example.com", email_confirmed_at: "2026-01-01" } } }); });
  it("rejects a replay without provisioning", async () => {
    m.claim.mockResolvedValue({ data: null, error: null });
    expect((await POST(request())).status).toBe(409);
    expect(m.provision).not.toHaveBeenCalled();
  });
  it("provisions only the application bound to a verified claim", async () => {
    m.claim.mockResolvedValueOnce({ data: { id: "claim", application_id: "application" }, error: null })
      .mockResolvedValueOnce({ data: { id: "claim" }, error: null });
    m.application.mockResolvedValue({ data: { resident_email: "owner@example.com" }, error: null });
    m.provision.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(200);
    expect(m.provision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "resident", applicationId: "application" }));
    expect(m.updates).toContainEqual({ status: "completed" });
  });
  it("re-enters the same processing claim after an interrupted worker", async () => {
    m.claim.mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { id: "claim", application_id: "application", status: "processing" }, error: null })
      .mockResolvedValueOnce({ data: { id: "claim" }, error: null });
    m.application.mockResolvedValue({ data: { resident_email: "owner@example.com" }, error: null });
    m.provision.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(200);
    expect(m.provision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "resident", applicationId: "application" }));
  });
  it("converges when two requests finish the same verified claim", async () => {
    const claim = { id: "claim", application_id: "application", status: "processing" };
    m.claim.mockResolvedValueOnce({ data: claim, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: claim, error: null })
      .mockResolvedValueOnce({ data: { id: "claim" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: { status: "completed" }, error: null });
    m.application.mockResolvedValue({ data: { resident_email: "owner@example.com" }, error: null });
    m.provision.mockResolvedValue(true);
    const responses = await Promise.all([POST(request()), POST(request())]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(m.provision).toHaveBeenCalledTimes(2);
    for (const call of m.provision.mock.calls) expect(call[1]).toMatchObject({ userId: "resident", applicationId: "application" });
  });
  it("refuses a vendor invite whose email changed before proof", async () => {
    m.claim.mockResolvedValue({ data: { id: "claim", intent: "vendor_invite", vendor_invite_id: "invite" }, error: null });
    m.invite.mockResolvedValue({ data: { vendor_email: "victim@example.com", status: "pending", expires_at: "2099-01-01" }, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(m.provision).not.toHaveBeenCalled();
  });
  it("fails closed on a vendor invite with malformed expiry", async () => {
    m.claim.mockResolvedValue({ data: { id: "claim", intent: "vendor_invite", vendor_invite_id: "invite" }, error: null });
    m.invite.mockResolvedValue({ data: { vendor_email: "owner@example.com", status: "pending", expires_at: "invalid" }, error: null });
    expect((await POST(request())).status).toBe(403);
  });
  it("refuses a paid purchase whose current email differs from the session", async () => {
    m.claim.mockResolvedValue({ data: { id: "claim", intent: "manager_paid", manager_purchase_id: "purchase" }, error: null });
    m.purchase.mockResolvedValue({ data: { email: "victim@example.com", user_id: null }, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(m.provision).not.toHaveBeenCalled();
  });
  it("rejects a tour whose current stored email no longer matches", async () => {
    m.claim.mockResolvedValue({ data: { id: "claim", intent: "tour", tour_inquiry_id: "tour-1" }, error: null });
    m.inquiry.mockResolvedValue({ email: "victim@example.com" });
    expect((await POST(request())).status).toBe(403);
    expect(m.tour).not.toHaveBeenCalled();
  });
  it("links only the inquiry bound to a verified pending handoff", async () => {
    m.claim.mockResolvedValueOnce({ data: { id: "claim", intent: "tour", tour_inquiry_id: "tour-1" }, error: null }).mockResolvedValueOnce({ data: { id: "claim" }, error: null });
    m.inquiry.mockResolvedValue({ email: "owner@example.com" });
    m.provision.mockResolvedValue(true);
    m.tour.mockResolvedValue({ ok: true });
    expect((await POST(request())).status).toBe(200);
    expect(m.tour).toHaveBeenCalledOnce();
    expect(m.tour).toHaveBeenCalledWith(expect.anything(), { userId: "resident", email: "owner@example.com", inquiryId: "tour-1" });
  });
  it("refuses an application for a different mailbox and releases the claim", async () => {
    m.claim.mockResolvedValue({ data: { id: "claim", application_id: "application" }, error: null });
    m.application.mockResolvedValue({ data: { resident_email: "victim@example.com" }, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(m.provision).not.toHaveBeenCalled();
    expect(m.updates).not.toContainEqual({ status: "completed" });
  });
});
