/**
 * Dispatch runs in the portal: the read endpoint and the manager actions
 * (vendor-dispatch-1018). The run is loaded under the workspace and owner
 * re-derived from the session; the engine functions (`runs.server.ts`) are
 * called with channel "portal" and the approver is the session, never the body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const getUser = vi.fn();
const linkedOwnerScope = vi.fn();
const approve = vi.fn();
const decline = vi.fn();
const retry = vi.fn();
const cancel = vi.fn();
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
vi.mock("@/lib/vendor-dispatch/runs.server", () => ({
  approveDispatchRun: (...a: unknown[]) => approve(...a),
  declineDispatchRun: (...a: unknown[]) => decline(...a),
  retryDispatchRun: (...a: unknown[]) => retry(...a),
  cancelDispatchRun: (...a: unknown[]) => cancel(...a),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const CO = "22222222-2222-4222-8222-222222222222";
const WS = "44444444-4444-4444-8444-444444444444";
const RUN_H1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_H2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_FOREIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const { GET } = await import("@/app/api/portal/vendor-dispatch/runs/route");
const { POST } = await import("@/app/api/portal/vendor-dispatch/runs/[id]/route");

function run(id: string, patch: Row = {}): Row {
  return {
    id,
    handle: 7,
    source_type: "work_order",
    source_id: `wo-${id.slice(0, 2)}`,
    trade: "locksmith",
    issue: "lockout",
    urgency: "emergency",
    property_id: "h1",
    offer_text: "Lockout in Capitol Hill. $120.",
    pay_cents: 12000,
    nte_cents: null,
    mode: "sequential",
    status: "awaiting_approval",
    approval_channel: null,
    approved_by: null,
    approved_at: null,
    accepted_vendor_directory_id: null,
    accepted_at: null,
    scheduled_for: null,
    workspace_id: WS,
    owner_user_id: OWNER,
    created_at: "2026-10-18T10:00:00.000Z",
    ...patch,
  };
}

function seed(): Record<string, Row[]> {
  return {
    profile_roles: [{ user_id: OWNER, role: "manager" }, { user_id: CO, role: "manager" }],
    profiles: [
      { id: OWNER, role: "manager", full_name: "Ora Owner" },
      { id: CO, role: "manager", full_name: "Cam Co" },
    ],
    manager_vendor_records: [{ id: "v1", manager_user_id: OWNER, row_data: { name: "Sam Locksmith" } }],
    vendor_dispatch_runs: [
      run(RUN_H1),
      run(RUN_H2, { property_id: "h2", source_id: "wo-bb" }),
      run(RUN_FOREIGN, { workspace_id: "other-ws", owner_user_id: "99999999-9999-4999-8999-999999999999" }),
    ],
    vendor_dispatch_attempts: [
      { id: "at1", run_id: RUN_H1, vendor_directory_id: "v1", position: 0, wave: 0, status: "queued", offered_at: null, responded_at: null, response_text: null },
    ],
  };
}

function post(id: string, payload: unknown) {
  return POST(
    new Request(`http://localhost/api/portal/vendor-dispatch/runs/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );
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
  for (const fn of [getUser, linkedOwnerScope, approve, decline, retry, cancel]) fn.mockReset();
  approve.mockResolvedValue({ ok: true, status: "offering" });
  decline.mockResolvedValue({ ok: true, status: "declined_by_manager" });
  retry.mockResolvedValue({ ok: true, status: "offering" });
  cancel.mockResolvedValue({ ok: true, status: "canceled" });
  grant([]);
});

describe("GET /api/portal/vendor-dispatch/runs", () => {
  it("returns the source's runs with attempts, never another workspace's run", async () => {
    asUser(OWNER);
    const res = await GET(new Request("http://localhost/api/portal/vendor-dispatch/runs"));
    const json = (await res.json()) as { runs: { id: string; attempts: { vendorName: string }[]; offerText: string }[] };
    expect(json.runs.map((r) => r.id).sort()).toEqual([RUN_H1, RUN_H2].sort());
    const h1 = json.runs.find((r) => r.id === RUN_H1)!;
    expect(h1.attempts[0]!.vendorName).toBe("Sam Locksmith");
    expect(h1.offerText).toContain("Capitol Hill");
  });

  it("filters by source and by status", async () => {
    asUser(OWNER);
    const bySource = (await (await GET(new Request("http://localhost/x?sourceType=work_order&sourceId=wo-bb"))).json()) as { runs: { id: string }[] };
    expect(bySource.runs.map((r) => r.id)).toEqual([RUN_H2]);
    db.tables.vendor_dispatch_runs![0]!.status = "offering";
    const awaiting = (await (await GET(new Request("http://localhost/x?status=awaiting_approval"))).json()) as { runs: { id: string }[] };
    expect(awaiting.runs.map((r) => r.id)).toEqual([RUN_H2]);
  });

  it("rejects an unknown status or source", async () => {
    asUser(OWNER);
    expect((await GET(new Request("http://localhost/x?status=nope"))).status).toBe(400);
    expect((await GET(new Request("http://localhost/x?sourceType=nope"))).status).toBe(400);
  });

  it("shows a co-manager only runs on houses they hold", async () => {
    asUser(CO);
    grant(["h2"]);
    const json = (await (await GET(new Request("http://localhost/x"))).json()) as { runs: { id: string }[] };
    expect(json.runs.map((r) => r.id)).toEqual([RUN_H2]);
  });

  it("answers empty when the dispatch tables do not exist yet", async () => {
    asUser(OWNER);
    const original = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === "vendor_dispatch_runs") {
        const builder = original(table);
        const chain: Record<string, unknown> = new Proxy({}, { get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: "42P01" } }) : () => chain) });
        void builder;
        return chain as never;
      }
      return original(table);
    }) as typeof db.from;
    const res = await GET(new Request("http://localhost/x"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown[] }).runs).toEqual([]);
  });
});

describe("POST /api/portal/vendor-dispatch/runs/[id]", () => {
  it("approves with the session as approver and channel portal, ignoring ids in the body", async () => {
    asUser(OWNER);
    const res = await post(RUN_H1, { action: "approve", ownerUserId: "attacker", actorUserId: "attacker", channel: "sms" });
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(db, { ownerUserId: OWNER, actorUserId: OWNER, channel: "portal", runId: RUN_H1, pickPosition: null });
  });

  it("picks one vendor by position", async () => {
    asUser(OWNER);
    await post(RUN_H1, { action: "pick", position: 1 });
    expect(approve).toHaveBeenCalledWith(db, expect.objectContaining({ pickPosition: 1, channel: "portal" }));
    expect((await post(RUN_H1, { action: "pick" })).status).toBe(400);
    expect((await post(RUN_H1, { action: "pick", position: -1 })).status).toBe(400);
  });

  it("maps retry, broadcast, decline and cancel onto the engine", async () => {
    asUser(OWNER);
    await post(RUN_H1, { action: "retry" });
    expect(retry).toHaveBeenLastCalledWith(db, expect.objectContaining({ broadcast: false, channel: "portal" }));
    await post(RUN_H1, { action: "broadcast" });
    expect(retry).toHaveBeenLastCalledWith(db, expect.objectContaining({ broadcast: true }));
    await post(RUN_H1, { action: "decline" });
    expect(decline).toHaveBeenCalledTimes(1);
    await post(RUN_H1, { action: "cancel" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("answers 409 when the engine says the run already moved on", async () => {
    asUser(OWNER);
    approve.mockResolvedValue({ ok: false, reason: "wrong_state" });
    expect((await post(RUN_H1, { action: "approve" })).status).toBe(409);
    approve.mockResolvedValue({ ok: false, reason: "no_vendors" });
    expect((await post(RUN_H1, { action: "approve" })).status).toBe(422);
    approve.mockResolvedValue({ ok: false, reason: "unavailable" });
    expect((await post(RUN_H1, { action: "approve" })).status).toBe(503);
  });

  it("reads another workspace's run as gone and never calls the engine", async () => {
    asUser(OWNER);
    expect((await post(RUN_FOREIGN, { action: "approve" })).status).toBe(404);
    expect((await post("not-a-uuid", { action: "approve" })).status).toBe(404);
    expect(approve).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    asUser(OWNER);
    expect((await post(RUN_H1, { action: "teleport" })).status).toBe(400);
  });

  it("refuses a co-manager without Services on the run's house", async () => {
    asUser(CO);
    grant(["h2"]);
    expect((await post(RUN_H1, { action: "approve" })).status).toBe(404);
    expect(approve).not.toHaveBeenCalled();
    const ok = await post(RUN_H2, { action: "approve" });
    expect(ok.status).toBe(200);
    expect(approve).toHaveBeenCalledWith(db, expect.objectContaining({ ownerUserId: OWNER, actorUserId: CO, channel: "portal" }));
    expect(linkedOwnerScope.mock.calls.at(-1)?.[3]).toBe("edit");
  });

  it("refuses a co-manager with no Services grant at all", async () => {
    asUser(CO);
    grant([]);
    expect((await post(RUN_H1, { action: "approve" })).status).toBe(403);
  });
});
