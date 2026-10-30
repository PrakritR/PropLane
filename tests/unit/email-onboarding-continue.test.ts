import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ user: vi.fn(), claim: vi.fn(), invite: vi.fn(), filters: [] as unknown[] }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: m.user } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => table === "vendor_invites" ? { select: () => ({ eq: () => ({ maybeSingle: m.invite }) }) } : ({ update: () => { const q = { eq: (key: string, value: unknown) => { m.filters.push([key, value]); return q; }, gt: () => q, select: () => q, maybeSingle: m.claim }; return q; }, select: () => { const q = { eq: (key: string, value: unknown) => { m.filters.push([key, value]); return q; }, gt: () => q, maybeSingle: m.claim }; return q; } }) }) }));
import { POST } from "@/app/api/auth/email-onboarding/continue/route";
describe("verified signup continuation", () => {
  beforeEach(() => { vi.clearAllMocks(); m.filters.length = 0; });
  it("requires a verified session before consuming a handoff", async () => {
    m.user.mockResolvedValue({ data: { user: null } });
    expect(await (await POST()).json()).toEqual({ role: null });
    expect(m.claim).not.toHaveBeenCalled();
  });
  it("atomically consumes only the current user's completed handoff", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "resident", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValue({ data: { intent: "manager" }, error: null });
    expect(await (await POST()).json()).toEqual({ role: "manager" });
    expect(m.filters).toContainEqual(["user_id", "resident"]);
    expect(m.filters).toContainEqual(["status", "completed"]);
  });
  it("returns the exact completed application for the verified user", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "resident", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValue({ data: { intent: "application", application_id: "APP-123" }, error: null });
    expect(await (await POST()).json()).toEqual({ role: "application", applicationId: "APP-123" });
    expect(m.filters).toContainEqual(["user_id", "resident"]);
  });
  it("returns the exact bound tour inquiry", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "resident", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValue({ data: { intent: "tour", tour_inquiry_id: "tour-123" }, error: null });
    expect(await (await POST()).json()).toEqual({ role: "tour", tourInquiryId: "tour-123" });
  });
  it("resolves only the matching verified vendor invite", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "resident", email: "owner@example.com", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValueOnce({ data: { intent: "vendor_invite", vendor_invite_id: "invite" }, error: null }).mockResolvedValueOnce({ data: { id: "claim" }, error: null });
    m.invite.mockResolvedValue({ data: { vendor_email: "owner@example.com", status: "pending", expires_at: "2099-01-01", invite_token: "invite-secret" }, error: null });
    expect(await (await POST()).json()).toEqual({ role: "vendor_invite", inviteToken: "invite-secret" });
    expect(m.filters).toContainEqual(["user_id", "resident"]);
  });
  it("does not return an invite belonging to another email", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "resident", email: "owner@example.com", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValue({ data: { intent: "vendor_invite", vendor_invite_id: "invite" }, error: null });
    m.invite.mockResolvedValue({ data: { vendor_email: "victim@example.com", status: "pending", expires_at: "2099-01-01", invite_token: "invite-secret" }, error: null });
    expect(await (await POST()).json()).toEqual({ role: null });
  });
  it("does not route on replay or a different user's claim", async () => {
    m.user.mockResolvedValue({ data: { user: { id: "other", email_confirmed_at: "2026-01-01" } } });
    m.claim.mockResolvedValue({ data: null, error: null });
    expect(await (await POST()).json()).toEqual({ role: null });
  });
});
