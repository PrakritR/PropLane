import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: { id: "u", email: "auth@example.test", email_confirmed_at: "yes" }, roles: ["resident"], sender: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: state.roles.map(role => ({ role })), error: null }) }) }) }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }), assertTestWorkspacePrincipalCompatibility: vi.fn() }));
vi.mock("@/lib/auth/effective-session", () => ({ getEffectiveUserIdForPortal: async () => null }));
vi.mock("@/lib/inbox-portal-sender", () => ({ resolveInboxSenderRoleForPortal: async (_db: unknown, args: { portal: string; isAdmin: boolean }) => args.isAdmin ? "admin" : state.roles.includes(args.portal) ? args.portal : null }));
vi.mock("@/lib/inbox-recipient-scope", () => ({ listEligibleInboxContacts: async (_db: unknown, sender: unknown) => { state.sender(sender); return []; } }));
import { GET } from "@/app/api/portal/inbox-eligible-contacts/route";
const request = () => new Request("https://example.test/api/portal/inbox-eligible-contacts?portal=resident");
beforeEach(() => { state.roles = ["resident"]; state.user.email_confirmed_at = "yes"; state.sender.mockClear(); });
it("binds email scope to the confirmed authenticated mailbox", async () => {
  expect((await GET(request())).status).toBe(200);
  expect(state.sender).toHaveBeenCalledWith(expect.objectContaining({ id: "u", email: "auth@example.test" }));
  state.user.email_confirmed_at = "";
  expect((await GET(request())).status).toBe(200);
  expect(state.sender).toHaveBeenLastCalledWith(expect.objectContaining({ id: "u", email: "" }));
});
it("denies legacy-only role before reading contacts", async () => {
  state.roles = [];
  expect((await GET(request())).status).toBe(403);
  expect(state.sender).not.toHaveBeenCalled();
});
