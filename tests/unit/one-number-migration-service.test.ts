import { describe, expect, it } from "vitest";
import { cleanName, holdsAdminRole, run } from "../../scripts/one-number/create-service-workspace.mjs";
import { run as shadow } from "../../scripts/one-number/shadow-report.mjs";
import { DEV_ENV, O1, PROD_ENV, PROD_REF, harness, world } from "./one-number-migration-fixtures";

const ADMIN = "admin-user";
const rpcOk = (args: Record<string, unknown>, tables: Record<string, any[]>) => {
  const id = `svc-${tables.portal_workspaces.length + 1}`;
  tables.portal_workspaces.push({ id, owner_user_id: args.p_owner, name: String(args.p_name).trim(), city: args.p_city ?? null, is_service: true, is_default: false });
  return { data: id, error: null };
};
const withOwner = (extra: Record<string, any[]> = {}) => ({
  platform_service_settings: [{ singleton: true, owner_user_id: ADMIN }],
  profile_roles: [{ user_id: ADMIN, role: "admin" }],
  ...extra,
});

async function svc(db: never, args: string[], deps: Record<string, unknown> = {}) {
  const h = harness();
  const code = await run(["--target", "dev", ...args], { env: { ...DEV_ENV }, db, log: h.log, report: h.report, ...deps });
  return { code, h };
}

describe("create-service-workspace", () => {
  it("dry run: says what it would create and writes nothing", async () => {
    const w = world(withOwner(), { rpc: { create_portal_service_workspace: rpcOk } });
    const { code, h } = await svc(w.db, ["--name", "PropLane Seattle", "--city", "Seattle"]);
    expect(code).toBe(0);
    expect(w.writes).toEqual([]);
    expect(h.text()).toMatch(/would create service workspace "PropLane Seattle" \(Seattle\)/);
    expect(h.report.created).toBe(false);
  });

  it("--apply creates it through the one writer, owned by the service owner, and moves no property", async () => {
    const w = world(withOwner({ manager_property_records: [{ id: "p1", manager_user_id: O1, workspace_id: "w" }] }), { rpc: { create_portal_service_workspace: rpcOk } });
    const { h } = await svc(w.db, ["--name", "PropLane Seattle", "--city", "Seattle", "--apply"]);
    const created = (w.tables.portal_workspaces as any[]).find((x) => x.name === "PropLane Seattle");
    expect(created).toMatchObject({ owner_user_id: ADMIN, is_service: true, city: "Seattle" });
    expect(h.report).toMatchObject({ created: true, workspaceId: created.id });
    expect((w.tables.manager_property_records as any[])[0].workspace_id).toBe("w");
  });

  it("is idempotent by name, case-insensitively", async () => {
    const w = world(withOwner(), { rpc: { create_portal_service_workspace: rpcOk } });
    await svc(w.db, ["--name", "PropLane Seattle", "--apply"]);
    const count = (w.tables.portal_workspaces as any[]).length;
    const again = await svc(w.db, ["--name", "proplane   seattle", "--apply"]);
    expect((w.tables.portal_workspaces as any[]).length).toBe(count);
    expect(again.h.text()).toMatch(/already exists/);
    expect(again.h.report.created).toBe(false);
  });

  it("refuses to repurpose an ordinary workspace of the same name", async () => {
    const w = world(withOwner({ portal_workspaces: [{ id: "x", owner_user_id: ADMIN, name: "PropLane Seattle", is_service: false, is_default: true }] }), { rpc: { create_portal_service_workspace: rpcOk } });
    await expect(svc(w.db, ["--name", "PropLane Seattle", "--apply"])).rejects.toThrow(/not a service workspace/);
  });

  it("refuses when the W15 migration is not applied", async () => {
    const w = world(withOwner(), { missingTables: ["platform_service_settings"] });
    await expect(svc(w.db, ["--name", "X"])).rejects.toThrow(/20261018260000_admin_service_workspaces/);
    const noColumn = world(withOwner(), { missingColumns: { portal_workspaces: ["is_service"] } });
    await expect(svc(noColumn.db, ["--name", "X"])).rejects.toThrow(/is_service/);
  });

  it("seeds the service owner only from a real admin account, and the stored row always wins", async () => {
    const noOwner = { platform_service_settings: [], profiles: [{ id: ADMIN, email: "ops@x.com", role: "admin" }, { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "a@x.com", role: "manager" }], profile_roles: [] };
    const w = world(noOwner, { rpc: { create_portal_service_workspace: rpcOk } });
    await expect(svc(w.db, ["--name", "X"])).rejects.toThrow(/No service owner is configured/);
    await expect(svc(w.db, ["--name", "X", "--owner-user-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])).rejects.toThrow(/does not hold the admin role/);
    await expect(svc(w.db, ["--name", "X", "--owner-user-id", "00000000-0000-4000-8000-000000000001"])).rejects.toThrow(/does not exist/);
    expect(w.tables.platform_service_settings).toHaveLength(0);

    const seeded = world({ ...noOwner, profiles: [{ id: "12345678-1234-4234-8234-123456789012", email: "ops@x.com", role: "admin" }] }, { rpc: { create_portal_service_workspace: rpcOk } });
    const dry = await svc(seeded.db, ["--name", "X", "--owner-user-id", "12345678-1234-4234-8234-123456789012"]);
    expect(dry.h.text()).toMatch(/would be seeded/);
    expect(seeded.tables.platform_service_settings).toHaveLength(0);
    await svc(seeded.db, ["--name", "X", "--owner-user-id", "12345678-1234-4234-8234-123456789012", "--apply"]);
    expect(seeded.tables.platform_service_settings).toMatchObject([{ singleton: true, owner_user_id: "12345678-1234-4234-8234-123456789012" }]);

    const stored = world(withOwner(), { rpc: { create_portal_service_workspace: rpcOk } });
    await expect(svc(stored.db, ["--name", "X", "--owner-user-id", "12345678-1234-4234-8234-123456789012"])).rejects.toThrow(/stored row always wins/);
  });

  it("reads the optional env var only to seed", async () => {
    const id = "12345678-1234-4234-8234-123456789012";
    const w = world({ platform_service_settings: [], profiles: [{ id, email: "o@x.com", role: "admin" }], profile_roles: [] }, { rpc: { create_portal_service_workspace: rpcOk } });
    const { h } = await svc(w.db, ["--name", "X"], { env: { ...DEV_ENV, PROPLANE_SERVICE_OWNER_USER_ID: id } });
    expect(h.text()).toMatch(/would be seeded/);
  });

  it("validates name and city", async () => {
    const w = world(withOwner());
    await expect(svc(w.db, [])).rejects.toThrow(/--name/);
    await expect(svc(w.db, ["--name", "x".repeat(81)])).rejects.toThrow(/--name/);
    await expect(svc(w.db, ["--name", "ok", "--city", "y".repeat(81)])).rejects.toThrow(/--city/);
    expect(cleanName("  A   B ")).toBe("A B");
  });

  it("a production write needs every guard", async () => {
    const w = world(withOwner());
    const args = ["--target", "production", "--name", "PropLane Seattle", "--apply"];
    const deps = { env: PROD_ENV, db: w.db, log: () => {} };
    await expect(run(args, deps)).rejects.toThrow(/confirm-ref/);
    await expect(run([...args, "--confirm-ref", PROD_REF], deps)).rejects.toThrow(/reason/);
    await expect(run([...args, "--confirm-ref", PROD_REF, "--reason", "create the Seattle workspace"], deps)).rejects.toThrow(/--backup/);
    expect(w.writes).toEqual([]);
  });

  it("holdsAdminRole mirrors the app: profile_roles, legacy role, primary email", async () => {
    const w = world({
      profile_roles: [{ user_id: "a", role: "admin" }],
      profiles: [{ id: "a", email: "a@x.com", role: "manager" }, { id: "b", email: "b@x.com", role: "Admin" }, { id: "c", email: "ops@proplane.test", role: "manager" }, { id: "d", email: "d@x.com", role: "manager" }],
    });
    expect(await holdsAdminRole(w.db, "a", "ops@proplane.test")).toBe(true);
    expect(await holdsAdminRole(w.db, "b", "ops@proplane.test")).toBe(true);
    expect(await holdsAdminRole(w.db, "c", "ops@proplane.test")).toBe(true);
    expect(await holdsAdminRole(w.db, "d", "ops@proplane.test")).toBe(false);
    expect(await holdsAdminRole(w.db, "nobody", "ops@proplane.test")).toBe(false);
  });
});

describe("shadow-report", () => {
  const NOW = Date.parse("2026-10-19T12:00:00Z");
  const row = (i: number, agrees: boolean | null, kind = "routed", at = "2026-10-19T10:00:00Z") => ({
    id: `s${i}`, message_sid: `SM${i}`, decision: { kind, workspaceId: "w" }, actual_owner_user_id: "o", actual_workspace_id: "w2", agrees, created_at: at,
  });
  async function report(rows: any[], args: string[] = []) {
    const w = world({ sms_line_shadow_decisions: rows });
    const h = harness();
    const code = await shadow(["--target", "dev", ...args], { env: DEV_ENV, db: w.db, log: h.log, report: h.report, now: NOW });
    return { code, h, w };
  }

  it("is READY at 98%+ over enough decided texts, ignoring undecided and old rows", async () => {
    const rows = [...Array.from({ length: 60 }, (_, i) => row(i, true)), row(100, false, "ambiguous"), row(101, null), row(102, false, "routed", "2026-10-01T00:00:00Z")];
    const { code, h } = await report(rows);
    expect(code).toBe(0);
    expect(h.report.shadow).toMatchObject({ total: 62, decided: 61, agree: 60, disagree: 1 });
    expect(h.text()).toMatch(/READY/);
    expect(h.text()).toMatch(/said "ambiguous": 1/);
  });

  it("is NOT READY below the agreement bar or the sample size, and read-only", async () => {
    const low = await report([...Array.from({ length: 50 }, (_, i) => row(i, true)), ...Array.from({ length: 10 }, (_, i) => row(100 + i, false))]);
    expect(low.code).toBe(1);
    expect(low.h.text()).toMatch(/Agreement is below the bar/);
    const few = await report([row(1, true)]);
    expect(few.code).toBe(1);
    expect(few.h.text()).toMatch(/Only 1 comparable/);
    expect(few.w.writes).toEqual([]);
  });

  it("explains a project where the table does not exist", async () => {
    const w = world({}, { missingTables: ["sms_line_shadow_decisions"] });
    const h = harness();
    expect(await shadow(["--target", "dev"], { env: DEV_ENV, db: w.db, log: h.log, now: NOW })).toBe(1);
    expect(h.text()).toMatch(/does not exist here/);
  });

  it("rejects nonsense thresholds", async () => {
    await expect(report([], ["--min-agreement", "2"])).rejects.toThrow(/min-agreement/);
    await expect(report([], ["--since-hours", "0"])).rejects.toThrow(/since-hours/);
  });
});
