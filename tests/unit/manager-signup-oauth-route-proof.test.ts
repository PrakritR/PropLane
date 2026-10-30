import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: mocks.user, getSession: async () => ({ data: { session: null } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/complete-manager-signup", () => ({ completeManagerSignupFromOAuth: mocks.complete }));
vi.mock("@/lib/google-calendar/link-after-manager-provision.server", () => ({ finalizeManagerGoogleCalendarLink: async () => ({ connected: false }) }));
vi.mock("@/lib/auth/manager-google-services-onboarding.server", () => ({ resolveManagerPortalEntryPath: async () => "/portal/dashboard" }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
import { POST } from "@/app/api/auth/manager-signup-oauth/route";
const request = () => new Request("https://example.test", { method: "POST", body: JSON.stringify({ sessionId: "axis_intent_one" }) });
beforeEach(() => { vi.clearAllMocks(); mocks.complete.mockResolvedValue({ ok: true, managerId: "manager" }); });
it("refuses an unconfirmed Auth session before provisioning", async () => {
  mocks.user.mockResolvedValue({ data: { user: { id: "user", email: "manager@example.test" } } });
  expect((await POST(request())).status).toBe(401);
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("passes a confirmed session to the exact purchase claim", async () => {
  mocks.user.mockResolvedValue({ data: { user: { id: "user", email: "manager@example.test", email_confirmed_at: "now" } } });
  expect((await POST(request())).status).toBe(200);
  expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), "user", "manager@example.test", "axis_intent_one");
});
