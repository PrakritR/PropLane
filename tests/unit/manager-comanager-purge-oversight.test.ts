import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ role: "admin", purge: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user" } } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: [{ role: state.role }], error: null }) }) }) }) }));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async (req: Request, _id: string, admin: boolean) => admin && new URL(req.url).searchParams.get("oversight") === "admin" }));
vi.mock("@/lib/auth/purge-orphaned-co-manager-links", () => ({ purgeOrphanedCoManagerLinks: state.purge }));
import { POST } from "@/app/api/pro/purge-orphaned-co-manager-links/route";
beforeEach(() => { state.role = "admin"; state.purge.mockClear(); });
it("keeps admin in own scope unless explicit oversight is requested", async () => {
  expect((await POST(new Request("https://example.test"))).status).toBe(200);
  expect(state.purge).toHaveBeenLastCalledWith(expect.anything(), { managerUserId: "user" });
  expect((await POST(new Request("https://example.test?oversight=admin"))).status).toBe(200);
  expect(state.purge).toHaveBeenLastCalledWith(expect.anything(), { managerUserId: null });
  state.role = "manager";
  expect((await POST(new Request("https://example.test?oversight=admin"))).status).toBe(200);
  expect(state.purge).toHaveBeenLastCalledWith(expect.anything(), { managerUserId: "user" });
});
