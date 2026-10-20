/** PATCH /api/admin/unassigned-leads/[id] with a workspaceId: admin only, service workspaces only, one audit row. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WS_SVC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";

let admin: { userId: string } | { status: 401 | 403 } = { userId: ADMIN };
const calls = vi.hoisted(() => ({ assign: [] as unknown[], audit: [] as unknown[] }));
let assignResult: unknown = { ok: true, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownerUserId: "11111111-1111-4111-8111-111111111111", label: "1. Ambika" };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/one-number/admin-leads-guard.server", () => ({ requirePlatformAdmin: async () => admin }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  loadServiceInboxScope: async () => ({ serviceOwnerIds: [], clientOwnerIds: [], workspaceIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }),
}));
vi.mock("@/lib/one-number/unassigned-leads.server", () => ({
  assignLeadToHouse: async (_db: unknown, input: unknown) => {
    calls.assign.push(input);
    return assignResult;
  },
  closeLead: async () => true,
}));
vi.mock("@/lib/tools/audit", () => ({
  writeAuditLog: async (actor: unknown, args: unknown) => {
    calls.audit.push({ actor: { ...(actor as object), db: undefined }, args });
    return { recorded: true };
  },
}));

const route = await import("@/app/api/admin/unassigned-leads/[id]/route");
const patch = (body: unknown, id = LEAD) =>
  route.PATCH(new Request("https://prop-lane.space/api/admin/unassigned-leads/x", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  calls.assign = [];
  calls.audit = [];
  admin = { userId: ADMIN };
  assignResult = { ok: true, workspaceId: WS_SVC, ownerUserId: OWNER, label: "1. Ambika" };
});

describe("assign a lead to a service workspace", () => {
  it("401 / 403 before anything runs", async () => {
    admin = { status: 401 };
    expect((await patch({ action: "assign", workspaceId: WS_SVC })).status).toBe(401);
    admin = { status: 403 };
    expect((await patch({ action: "assign", workspaceId: WS_SVC })).status).toBe(403);
    expect(calls.assign).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it("assigns by workspace, as admin, and writes one audit row naming the admin and the workspace", async () => {
    const res = await patch({ action: "assign", workspaceId: WS_SVC.toUpperCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, workspaceId: WS_SVC, auditRecorded: true });
    expect(calls.assign).toEqual([{ leadId: LEAD, workspaceId: WS_SVC, by: "admin" }]);
    expect(calls.audit).toHaveLength(1);
    expect(calls.audit[0]).toMatchObject({
      actor: { landlordId: OWNER, userId: ADMIN },
      args: { action: "admin_lead_assign_workspace", inputSummary: { leadId: LEAD, workspaceId: WS_SVC } },
    });
  });

  it("404 for a workspace that is not a service workspace, and nothing is assigned or audited", async () => {
    expect((await patch({ action: "assign", workspaceId: WS_OTHER })).status).toBe(404);
    expect((await patch({ action: "assign", workspaceId: "nope" })).status).toBe(404);
    expect(calls.assign).toEqual([]);
    expect(calls.audit).toEqual([]);
  });

  it("a lead that is no longer open is 409 and writes no audit row", async () => {
    assignResult = { ok: false, error: "lead_not_open" };
    expect((await patch({ action: "assign", workspaceId: WS_SVC })).status).toBe(409);
    expect(calls.audit).toEqual([]);
  });

  it("the house path is unchanged", async () => {
    expect((await patch({ action: "assign", propertyId: "prop-1" })).status).toBe(200);
    expect(calls.assign).toEqual([{ leadId: LEAD, propertyId: "prop-1", by: "admin" }]);
    expect(calls.audit).toEqual([]);
  });
});
