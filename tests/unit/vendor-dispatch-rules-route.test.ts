/**
 * Dispatch rules: workspace scoping and permissions (vendor-dispatch-1018).
 * Every id in a body is untrusted: a vendor must be a roster row of the workspace
 * OWNER, a house must belong to the workspace, and a co-manager needs the Services
 * module on the houses involved at the asked level.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const getUser = vi.fn();
const linkedOwnerScope = vi.fn();
let db: FakeDb;

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "ok" }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: (...args: unknown[]) => linkedOwnerScope(...args),
}));
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: async () => ({
    id: WS,
    name: "Home",
    ownerUserId: OWNER,
    owned: false,
    isDefault: true,
    propertyIds: ["h1", "h2"],
  }),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const RULE_H2 = "55555555-5555-4555-8555-555555555555";

const { GET, POST } = await import("@/app/api/portal/vendor-dispatch/rules/route");
const { PATCH, DELETE } = await import("@/app/api/portal/vendor-dispatch/rules/[id]/route");

function seed(): Record<string, Row[]> {
  return {
    profile_roles: [{ user_id: OWNER, role: "manager" }, { user_id: CO, role: "manager" }],
    profiles: [
      { id: OWNER, role: "manager" },
      { id: CO, role: "manager" },
    ],
    manager_vendor_records: [
      { id: "v-own-1", manager_user_id: OWNER, row_data: { name: "Sam Locksmith" } },
      { id: "v-own-2", manager_user_id: OWNER, row_data: { name: "Lee Locks" } },
      { id: "v-foreign", manager_user_id: STRANGER, row_data: { name: "Not Mine" } },
    ],
    vendor_dispatch_rules: [
      {
        id: RULE_H2,
        workspace_id: WS,
        owner_user_id: OWNER,
        name: "H2 lockout",
        trade: "locksmith",
        issue: "lockout",
        property_scope: "selected",
        property_ids: ["h2"],
        urgencies: ["emergency"],
        hours: "any",
        mode: "sequential",
        broadcast_size: 3,
        timeout_minutes: null,
        pay_cents: 12000,
        pay_model: "flat",
        nte_cents: null,
        active: true,
        created_at: "2026-10-18T10:00:00.000Z",
        updated_at: "2026-10-18T10:00:00.000Z",
      },
    ],
    vendor_dispatch_rule_vendors: [{ rule_id: RULE_H2, vendor_directory_id: "v-own-1", position: 0 }],
  };
}

const body = {
  name: "Lockouts",
  trade: "locksmith",
  issue: "lockout",
  propertyScope: "all",
  propertyIds: [],
  urgencies: ["emergency"],
  hours: "any",
  mode: "sequential",
  broadcastSize: 3,
  timeoutMinutes: null,
  payCents: 12000,
  payModel: "flat",
  nteCents: null,
  vendorIds: ["v-own-1", "v-own-2"],
};

function jsonRequest(method: string, payload?: unknown) {
  return new Request("http://localhost/api/portal/vendor-dispatch/rules", {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function asUser(id: string) {
  getUser.mockResolvedValue({ data: { user: { id, user_metadata: { role: "manager" } } } });
}

function grant(houses: string[]) {
  linkedOwnerScope.mockResolvedValue({
    ownerIds: new Set(houses.length ? [OWNER] : []),
    propertyIds: new Set(houses),
    propertyIdsByOwner: new Map(houses.length ? [[OWNER, new Set(houses)]] : []),
  });
}

beforeEach(() => {
  db = createFakeDb(seed());
  getUser.mockReset();
  linkedOwnerScope.mockReset();
  grant([]);
});

describe("POST /api/portal/vendor-dispatch/rules", () => {
  it("refuses a vendor that belongs to another manager, and writes nothing", async () => {
    asUser(OWNER);
    // The workspace owner acts in their own workspace.
    vi.mocked(getUser);
    const res = await POST(jsonRequest("POST", { ...body, vendorIds: ["v-own-1", "v-foreign"] }));
    expect(res.status).toBe(403);
    expect(db.tables.vendor_dispatch_rules).toHaveLength(1);
  });

  it("refuses a house outside the workspace", async () => {
    asUser(OWNER);
    const res = await POST(jsonRequest("POST", { ...body, propertyScope: "selected", propertyIds: ["h1", "h-elsewhere"] }));
    expect(res.status).toBe(403);
    expect(db.tables.vendor_dispatch_rules).toHaveLength(1);
  });

  it("refuses an invalid body with 400 before touching the database", async () => {
    asUser(OWNER);
    const res = await POST(jsonRequest("POST", { ...body, vendorIds: [] }));
    expect(res.status).toBe(400);
  });

  it("creates the rule under the workspace and owner re-derived from the session, ignoring ids in the body", async () => {
    asUser(OWNER);
    const res = await POST(
      jsonRequest("POST", { ...body, workspace_id: "other", workspaceId: "other", owner_user_id: STRANGER }),
    );
    expect(res.status).toBe(201);
    const created = db.tables.vendor_dispatch_rules!.at(-1)!;
    expect(created.workspace_id).toBe(WS);
    expect(created.owner_user_id).toBe(OWNER);
    const chain = db.tables.vendor_dispatch_rule_vendors!.filter((row) => row.rule_id === created.id);
    expect(chain.map((row) => [row.vendor_directory_id, row.position])).toEqual([
      ["v-own-1", 0],
      ["v-own-2", 1],
    ]);
  });

  it("refuses a co-manager with no Services grant in the workspace", async () => {
    asUser(CO);
    grant([]);
    const res = await POST(jsonRequest("POST", body));
    expect(res.status).toBe(403);
    expect(db.tables.vendor_dispatch_rules).toHaveLength(1);
  });

  it("asks for the Services module at edit level for writes and read level for reads", async () => {
    asUser(CO);
    grant(["h1", "h2"]);
    await POST(jsonRequest("POST", body));
    expect(linkedOwnerScope.mock.calls.at(-1)?.[2]).toBe("services");
    expect(linkedOwnerScope.mock.calls.at(-1)?.[3]).toBe("edit");
    await GET();
    expect(linkedOwnerScope.mock.calls.at(-1)?.[3]).toBe("read");
  });

  it("refuses a workspace-wide rule from a co-manager who holds only some houses", async () => {
    asUser(CO);
    grant(["h1"]);
    const res = await POST(jsonRequest("POST", body));
    expect(res.status).toBe(403);
  });

  it("refuses a rule naming a house the co-manager does not hold, and allows one they do", async () => {
    asUser(CO);
    grant(["h1"]);
    const denied = await POST(jsonRequest("POST", { ...body, propertyScope: "selected", propertyIds: ["h2"] }));
    expect(denied.status).toBe(403);
    const allowed = await POST(jsonRequest("POST", { ...body, propertyScope: "selected", propertyIds: ["h1"] }));
    expect(allowed.status).toBe(201);
  });
});

describe("GET /api/portal/vendor-dispatch/rules", () => {
  it("lists the workspace's rules with the ordered chain and vendor names", async () => {
    asUser(OWNER);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rules: { id: string; vendors: { name: string; position: number }[] }[]; workspacePropertyIds: string[] };
    expect(json.rules.map((rule) => rule.id)).toEqual([RULE_H2]);
    expect(json.rules[0]!.vendors).toEqual([expect.objectContaining({ name: "Sam Locksmith", position: 0 })]);
    expect(json.workspacePropertyIds).toEqual(["h1", "h2"]);
  });

  it("does not list another workspace's rule", async () => {
    asUser(OWNER);
    db.tables.vendor_dispatch_rules!.push({ ...db.tables.vendor_dispatch_rules![0]!, id: "66666666-6666-4666-8666-666666666666", workspace_id: "other-ws" });
    const json = (await (await GET()).json()) as { rules: { id: string }[] };
    expect(json.rules.map((rule) => rule.id)).toEqual([RULE_H2]);
  });

  it("shows a co-manager only the rules that touch their houses", async () => {
    asUser(CO);
    grant(["h1"]);
    const json = (await (await GET()).json()) as { rules: { id: string }[] };
    expect(json.rules).toEqual([]);
    grant(["h2"]);
    const seen = (await (await GET()).json()) as { rules: { id: string }[]; workspacePropertyIds: string[] };
    expect(seen.rules.map((rule) => rule.id)).toEqual([RULE_H2]);
    expect(seen.workspacePropertyIds).toEqual(["h2"]);
  });

  it("refuses an unauthenticated caller", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
  });
});

describe("PATCH / DELETE /api/portal/vendor-dispatch/rules/[id]", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("pauses a rule with { active: false } and keeps its chain", async () => {
    asUser(OWNER);
    const res = await PATCH(jsonRequest("PATCH", { active: false }), ctx(RULE_H2));
    expect(res.status).toBe(200);
    expect(db.tables.vendor_dispatch_rules![0]!.active).toBe(false);
    expect(db.tables.vendor_dispatch_rule_vendors).toHaveLength(1);
  });

  it("replaces the chain in order when vendors change", async () => {
    asUser(OWNER);
    const res = await PATCH(jsonRequest("PATCH", { vendorIds: ["v-own-2", "v-own-1"] }), ctx(RULE_H2));
    expect(res.status).toBe(200);
    expect(db.tables.vendor_dispatch_rule_vendors!.map((row) => [row.vendor_directory_id, row.position])).toEqual([
      ["v-own-2", 0],
      ["v-own-1", 1],
    ]);
  });

  it("refuses to swap in a foreign vendor on update", async () => {
    asUser(OWNER);
    const res = await PATCH(jsonRequest("PATCH", { vendorIds: ["v-foreign"] }), ctx(RULE_H2));
    expect(res.status).toBe(403);
    expect(db.tables.vendor_dispatch_rule_vendors!.map((row) => row.vendor_directory_id)).toEqual(["v-own-1"]);
  });

  it("reads another workspace's rule id as not found", async () => {
    asUser(OWNER);
    db.tables.vendor_dispatch_rules![0]!.workspace_id = "other-ws";
    expect((await PATCH(jsonRequest("PATCH", { active: false }), ctx(RULE_H2))).status).toBe(404);
    expect((await DELETE(jsonRequest("DELETE"), ctx(RULE_H2))).status).toBe(404);
  });

  it("refuses a co-manager who does not hold the rule's house, and a malformed id", async () => {
    asUser(CO);
    grant(["h1"]);
    expect((await PATCH(jsonRequest("PATCH", { active: false }), ctx(RULE_H2))).status).toBe(404);
    expect((await DELETE(jsonRequest("DELETE"), ctx(RULE_H2))).status).toBe(404);
    expect((await DELETE(jsonRequest("DELETE"), ctx("not-a-uuid"))).status).toBe(404);
    expect(db.tables.vendor_dispatch_rules).toHaveLength(1);
  });

  it("asks for delete level on DELETE and lets a granted co-manager delete", async () => {
    asUser(CO);
    grant(["h2"]);
    const res = await DELETE(jsonRequest("DELETE"), ctx(RULE_H2));
    expect(res.status).toBe(200);
    expect(linkedOwnerScope.mock.calls.at(-1)?.[3]).toBe("delete");
    expect(db.tables.vendor_dispatch_rules).toHaveLength(0);
  });
});
