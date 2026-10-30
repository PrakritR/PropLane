import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: null as null | { id: string; email: string; email_confirmed_at: string }, purchase: { id: "purchase", email: "a@example.test", manager_id: "manager", user_id: null as string | null }, profile: null as null | Record<string, string>, upsert: vi.fn(), claim: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "profiles" ? state.profile : state.purchase, error: null }), upsert: state.upsert };
  return query;
} }) }));
vi.mock("@/lib/auth/claim-manager-purchase.server", () => ({ claimManagerPurchase: state.claim }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/manager-signup-intent", () => ({ isAxisIntentSessionId: () => true }));
import { POST } from "@/app/api/auth/manager-signup/route";
const post = (body: unknown) => POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }));
const body = { sessionId: "session", fullName: "New Name", phone: "+12065550123" };
beforeEach(() => { vi.clearAllMocks(); state.user = { id: "user", email: "a@example.test", email_confirmed_at: "2026-01-01" }; state.profile = null; state.purchase.user_id = null; state.upsert.mockResolvedValue({ error: null }); state.claim.mockResolvedValue(true); });
describe("paid manager verified details", () => {
  it("refuses missing name or invalid phone before purchase claim", async () => {
    expect((await post({ ...body, phone: "invalid" })).status).toBe(400);
    expect((await post({ ...body, fullName: " " })).status).toBe(400);
    expect(state.claim).not.toHaveBeenCalled();
  });
  it("refuses another email without writing or claiming", async () => {
    state.user!.email = "other@example.test";
    expect((await post(body)).status).toBe(403);
    expect(state.claim).not.toHaveBeenCalled(); expect(state.upsert).not.toHaveBeenCalled();
  });
  it("records submitted details on a new profile and preserves existing edits", async () => {
    expect((await post(body)).status).toBe(200);
    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({ full_name: "New Name", phone: "+12065550123" }), expect.anything());
    state.profile = { full_name: "Existing Name", phone: "+12065550999", manager_id: "existing", role: "resident" };
    expect((await post(body)).status).toBe(200);
    expect(state.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ full_name: "Existing Name", phone: "+12065550999", manager_id: "existing" }), expect.anything());
  });
});
