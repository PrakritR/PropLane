/**
 * The PropLane line (admin Property management): admin-only mode / number changes, a required reason, an audit
 * row BEFORE the change, E.164 validation, and no Twilio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const MANAGER = "44444444-4444-4444-8444-444444444444";
const WS1 = "66666666-6666-4666-8666-666666666661";
const WS2 = "66666666-6666-4666-8666-666666666662";

let db: ServiceFakeDb;
let signedIn: string | null = ADMIN;
const admins = new Set([ADMIN]);

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: signedIn } : null } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => admins.has(id) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => db }));

const line = await import("@/lib/service/proplane-line.server");
const route = await import("@/app/api/admin/proplane-line/route");

const patch = (body: unknown) =>
  route.PATCH(new Request("https://prop-lane.space/api/admin/proplane-line", { method: "PATCH", body: JSON.stringify(body) }));

const GOOD = { mode: "shared", sharedNumber: "+12065550100", pilotWorkspaceIds: [], reason: "Go live for Seattle" };

beforeEach(() => {
  signedIn = ADMIN;
  db = makeServiceFakeDb({
    sms_runtime_config: [{ singleton: true, line_mode: "per_workspace", shared_number_e164: null, shared_pilot_workspace_ids: [], mode: "automatic" }],
    portal_workspaces: [{ id: WS1 }, { id: WS2 }],
    audit_log: [],
  });
});

describe("the gate", () => {
  it("401 signed out and 403 for a non-admin on both verbs, and nothing changes", async () => {
    signedIn = null;
    expect((await route.GET()).status).toBe(401);
    expect((await patch(GOOD)).status).toBe(401);
    signedIn = MANAGER;
    expect((await route.GET()).status).toBe(403);
    expect((await patch(GOOD)).status).toBe(403);
    expect(db.tables.sms_runtime_config[0]).toMatchObject({ line_mode: "per_workspace", shared_number_e164: null });
    expect(db.tables.audit_log).toHaveLength(0);
  });
});

describe("changing the line", () => {
  it("applies mode, number and workspaces, and records the audit row with before, after and the reason", async () => {
    const res = await patch({ ...GOOD, pilotWorkspaceIds: [WS1.toUpperCase()] });
    expect(res.status).toBe(200);
    expect(db.tables.sms_runtime_config[0]).toMatchObject({ line_mode: "shared", shared_number_e164: "+12065550100", shared_pilot_workspace_ids: [WS1] });
    const audit = db.tables.audit_log[0]!;
    expect(audit).toMatchObject({ actor_user_id: ADMIN, action: "admin_proplane_line_change", result_summary: { applied: true } });
    expect(audit.input_summary).toMatchObject({
      reason: "Go live for Seattle",
      before: { mode: "per_workspace", sharedNumber: null, pilotWorkspaceIds: [] },
      after: { mode: "shared", sharedNumber: "+12065550100", pilotWorkspaceIds: [WS1] },
    });
  });

  it("requires a reason, before touching anything", async () => {
    for (const reason of [undefined, "", "   ", 5]) {
      expect((await patch({ ...GOOD, reason })).status).toBe(400);
    }
    expect(db.tables.audit_log).toHaveLength(0);
    expect(db.tables.sms_runtime_config[0]!.line_mode).toBe("per_workspace");
  });

  it("validates the mode, the E.164 number, and that shared has one", async () => {
    expect((await patch({ ...GOOD, mode: "live" })).status).toBe(400);
    expect((await patch({ ...GOOD, sharedNumber: "206-555" })).status).toBe(400);
    expect((await patch({ ...GOOD, sharedNumber: "abc" })).status).toBe(400);
    expect((await patch({ ...GOOD, sharedNumber: null })).status).toBe(400);
    // A bare US number normalizes to E.164; shadow and per_workspace may leave it empty.
    expect((await patch({ ...GOOD, sharedNumber: "(206) 555-0100" })).status).toBe(200);
    expect(db.tables.sms_runtime_config[0]!.shared_number_e164).toBe("+12065550100");
    expect((await patch({ mode: "shadow", sharedNumber: null, pilotWorkspaceIds: [], reason: "back to shadow" })).status).toBe(200);
    expect(db.tables.sms_runtime_config[0]).toMatchObject({ line_mode: "shadow", shared_number_e164: null });
  });

  it("rejects workspaces that do not exist, malformed ids and a non-list", async () => {
    expect((await patch({ ...GOOD, pilotWorkspaceIds: ["77777777-7777-4777-8777-777777777777"] })).status).toBe(400);
    expect((await patch({ ...GOOD, pilotWorkspaceIds: ["nope"] })).status).toBe(400);
    expect((await line.changeProplaneLine(db as never, ADMIN, { ...GOOD, pilotWorkspaceIds: "x" })).ok).toBe(false);
    expect(db.tables.audit_log).toHaveLength(0);
  });

  it("refuses a no-op with 409 and writes no audit row", async () => {
    expect((await patch({ mode: "per_workspace", sharedNumber: null, pilotWorkspaceIds: [], reason: "same" })).status).toBe(409);
    expect(db.tables.audit_log).toHaveLength(0);
  });

  it("changes NOTHING when the audit row cannot be written", async () => {
    db.failInsertOn.add("audit_log");
    const res = await patch(GOOD);
    expect(res.status).toBe(503);
    expect(db.tables.sms_runtime_config[0]).toMatchObject({ line_mode: "per_workspace", shared_number_e164: null });
  });

  it("stamps the audit row as not applied when the save fails", async () => {
    db.failUpdateOn.add("sms_runtime_config");
    const res = await patch(GOOD);
    expect(res.status).toBe(503);
    expect(db.tables.audit_log[0]!.result_summary).toEqual({ applied: false, failed: true });
  });

  it("is a 409 when the one-number migration has not run here", async () => {
    db.failOn.sms_runtime_config = { code: "42703", message: "no column" };
    expect((await patch(GOOD)).status).toBe(409);
    const read = await line.readProplaneLine(db as never);
    expect(read).toMatchObject({ ok: true, configured: false });
  });
});

describe("reading the line", () => {
  it("returns the stored state and the last change", async () => {
    await patch(GOOD);
    const res = await route.GET();
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ configured: true, mode: "shared", sharedNumber: "+12065550100", pilotWorkspaceIds: [] });
    expect(json.lastChange).toMatchObject({ reason: "Go live for Seattle", actorUserId: ADMIN });
  });
});

describe("no Twilio", () => {
  it("the line module and route never import a provider", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/service/proplane-line.server.ts", "src/app/api/admin/proplane-line/route.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/^import .*(twilio|@\/lib\/sms\/)/im);
    }
  });
});
