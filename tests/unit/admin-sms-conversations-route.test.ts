/** GET /api/admin/sms-conversations: admin only, and `?workspaceId=` is `unassigned` or a service workspace this surface reads. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const WS_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let signedIn: string | null = null;
const calls = vi.hoisted(() => ({ fetch: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: signedIn } : null } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => id === "22222222-2222-4222-8222-222222222222" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/claw-resident-messaging.server", () => ({
  resolveAdminForwardPhone: async () => null,
  resolveManagerUserIdForPhone: async () => null,
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: async () => ({ ok: true }) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  ADMIN_SMS_UNASSIGNED_FILTER: "unassigned",
  loadServiceInboxScope: async () => ({ serviceOwnerIds: [], clientOwnerIds: [], workspaceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }),
  fetchAdminSmsConversations: async (_db: unknown, options: unknown) => {
    calls.fetch.push(options);
    return { residents: [], workspaces: [] };
  },
}));

const route = await import("@/app/api/admin/sms-conversations/route");
const get = (query = "") => route.GET(new Request(`https://prop-lane.space/api/admin/sms-conversations${query}`));

beforeEach(() => {
  calls.fetch = [];
  signedIn = ADMIN;
});

describe("GET /api/admin/sms-conversations", () => {
  it("401 signed out and 403 for a non-admin, before any read", async () => {
    signedIn = null;
    expect((await get()).status).toBe(401);
    signedIn = "44444444-4444-4444-8444-444444444444";
    expect((await get(`?workspaceId=${WS_SVC}`)).status).toBe(403);
    expect(calls.fetch).toEqual([]);
  });

  it("no parameter reads every workspace, leads included", async () => {
    expect((await get()).status).toBe(200);
    expect(calls.fetch).toEqual([{ workspaceId: null, includeLeads: true }]);
  });

  it("passes `unassigned` and a known service workspace id through", async () => {
    expect((await get("?workspaceId=unassigned")).status).toBe(200);
    expect((await get(`?workspaceId=${WS_SVC.toUpperCase()}`)).status).toBe(200);
    expect(calls.fetch).toEqual([
      { workspaceId: "unassigned", includeLeads: true },
      { workspaceId: WS_SVC, includeLeads: true },
    ]);
  });

  it("400 for a value that is not an id, 404 for a workspace that is not a service workspace; nothing is read", async () => {
    expect((await get("?workspaceId=not-an-id")).status).toBe(400);
    expect((await get(`?workspaceId=${WS_OTHER}`)).status).toBe(404);
    expect(calls.fetch).toEqual([]);
  });
});
