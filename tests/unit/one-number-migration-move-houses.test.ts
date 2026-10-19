/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import { run as backup } from "../../scripts/one-number/backup.mjs";
import {
  ADMIN_STAMP,
  MOVED_ASSIGNED_TABLES,
  MOVED_PROPERTY_TABLES,
  UNMOVED_PROPERTY_TABLES,
  classifyWorkspaces,
  houseCity,
} from "../../scripts/one-number/lib/move-plan.mjs";
import { run } from "../../scripts/one-number/move-houses-to-service.mjs";
import { fakeMigrationDb, type FakeRow } from "../helpers/migration-fake-db";
import { DEV_ENV, PROD_ENV, PROD_REF, harness } from "./one-number-migration-fixtures";

const root = join(__dirname, "..", "..");
const S = "svc-owner";
const A = "ambika";
const V = "vinod";
const WA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WV = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A port of transfer_portal_workspace_ownership (+ ensure_default_portal_workspace) over the fake tables. */
function transfer(args: Record<string, any>, t: Record<string, FakeRow[]>) {
  const ws = t.portal_workspaces.find((w) => w.id === args.p_workspace && w.owner_user_id === args.p_from);
  if (!ws) return { data: null, error: { code: "P0002", message: "Workspace not found or you are not its owner." } };
  const member = t.account_link_invites.find((m) => m.inviter_user_id === args.p_from && m.invitee_user_id === args.p_to && m.workspace_id === ws.id && m.status === "accepted");
  if (!member) return { data: null, error: { code: "P0002", message: "That person is not an accepted member of this workspace." } };
  ws.owner_user_id = args.p_to;
  ws.is_default = false;
  const houses = t.manager_property_records.filter((h) => h.workspace_id === ws.id);
  for (const h of houses) h.manager_user_id = args.p_to;
  const ids = houses.map((h) => h.id);
  for (const table of MOVED_PROPERTY_TABLES) for (const r of t[table] ?? []) if (r.manager_user_id === args.p_from && ids.includes(r.property_id)) r.manager_user_id = args.p_to;
  for (const table of MOVED_ASSIGNED_TABLES) for (const r of t[table] ?? []) if (r.manager_user_id === args.p_from && ids.includes(r.assigned_property_id)) r.manager_user_id = args.p_to;
  t.account_link_invites.splice(t.account_link_invites.indexOf(member), 1);
  let moved = 0;
  for (const m of t.account_link_invites) if (m.workspace_id === ws.id && m.inviter_user_id === args.p_from && ["pending", "accepted"].includes(m.status as string)) { m.inviter_user_id = args.p_to; moved += 1; }
  if (args.p_former_role !== "nothing") {
    t.account_link_invites.push({ id: `link-${t.account_link_invites.length + 100}`, inviter_user_id: args.p_to, invitee_user_id: args.p_from, workspace_id: ws.id, team_role: args.p_former_role, house_scope: "all", status: "accepted", assigned_property_ids: ids, co_manager_permissions: args.p_former_permissions, is_owner_of_record: false });
  }
  for (const n of t.manager_sms_numbers) if (n.workspace_id === ws.id && n.manager_user_id === args.p_from) n.manager_user_id = args.p_to;
  for (const e of t.manager_assistant_emails) if (e.workspace_id === ws.id && e.manager_user_id === args.p_from) e.manager_user_id = args.p_to;
  return { data: { houses: houses.length, members: moved }, error: null };
}
function ensureDefault(args: Record<string, any>, t: Record<string, FakeRow[]>) {
  const have = t.portal_workspaces.find((w) => w.owner_user_id === args.p_owner && w.is_default);
  if (have) return { data: have.id, error: null };
  const id = `default-${t.portal_workspaces.length + 1}`;
  t.portal_workspaces.push({ id, owner_user_id: args.p_owner, name: "My workspace", is_default: true, is_service: false, city: null });
  return { data: id, error: null };
}

function seedMove(extra: Record<string, FakeRow[]> = {}): Record<string, FakeRow[]> {
  const house = (id: string, ws: string, owner: string, address: string, status = "live") => ({ id, workspace_id: ws, manager_user_id: owner, status, property_data: { address }, row_data: {} });
  return {
    platform_service_settings: [{ singleton: true, owner_user_id: S }],
    profiles: [
      { id: S, email: "admin@proplane.test", full_name: "PropLane", manager_id: "AX-S", sms_from_number: null },
      { id: A, email: "ambika@example.com", full_name: "Ambika Mago", manager_id: "AX-A", sms_from_number: "+12065550111" },
      { id: V, email: "vinod@example.com", full_name: "Vinod", manager_id: "AX-V", sms_from_number: null },
    ],
    portal_workspaces: [
      { id: S + "-default", owner_user_id: S, name: "My workspace", is_default: true, is_service: false, city: null, owner_of_record_name: null },
      { id: WA, owner_user_id: A, name: "SEATTLE HOMES", is_default: true, is_service: false, city: null, owner_of_record_name: null },
      { id: WV, owner_user_id: V, name: "My workspace", is_default: true, is_service: false, city: null, owner_of_record_name: null },
      { id: WM, owner_user_id: A, name: "Mixed", is_default: false, is_service: false, city: null, owner_of_record_name: null },
    ],
    manager_property_records: [
      house("h1", WA, A, "1 Pine St, Seattle, WA 98101"),
      house("h2", WA, A, "2 Pike St, Seattle, WA 98101"),
      house("h3", WA, A, "3 Union St, seattle WA 98101"),
      { id: "d1", workspace_id: WV, manager_user_id: V, status: "draft", property_data: {}, row_data: {} },
      house("m1", WM, A, "9 Main St, Seattle, WA 98101"),
      house("m2", WM, A, "9 Main St, Tacoma, WA 98402"),
    ],
    portal_lease_pipeline_records: [
      { id: "l1", manager_user_id: A, property_id: "h1", status: "signed", resident_email: "r1@x.com" },
      { id: "l2", manager_user_id: A, property_id: "h2", status: "Terminated", resident_email: "r2@x.com" },
      { id: "l3", manager_user_id: A, property_id: "m1", status: "signed", resident_email: "r3@x.com" },
    ],
    portal_household_charge_records: [
      { id: "c1", manager_user_id: A, property_id: "h1", status: "pending" },
      { id: "c2", manager_user_id: A, property_id: "h1", status: "paid" },
    ],
    portal_schedule_records: [
      { id: "s1", manager_user_id: A, property_id: "h1", record_type: "room_date_block", ends_at: "2099-01-01T00:00:00Z" },
      { id: "s2", manager_user_id: A, property_id: "h3", record_type: "tour", ends_at: null },
    ],
    manager_application_records: [{ id: "ap1", manager_user_id: A, property_id: null, assigned_property_id: "h2" }],
    manager_sms_conversation_houses: [{ id: "ch1", manager_user_id: A, property_id: "h1" }],
    manager_sms_numbers: [{ id: "n1", manager_user_id: A, workspace_id: WA, phone_number: "+12065550111", provision_state: "active", released_at: null }],
    manager_assistant_emails: [{ id: "e1", manager_user_id: A, workspace_id: WA, provision_state: "active" }],
    workspace_work_numbers: [{ workspace_id: WA, number_id: "n1", is_primary: true }],
    account_link_invites: [
      { id: "m-co", inviter_user_id: A, invitee_user_id: "co-manager", workspace_id: WA, team_role: "leasing", house_scope: "selected", status: "accepted", assigned_property_ids: ["h1"], is_owner_of_record: false },
    ],
    sms_projection_conversations: [{ id: "cv1", owner_manager_user_id: A, workspace_id: WA }],
    ...extra,
  };
}

function world(extra: Record<string, FakeRow[]> = {}, rpc: Record<string, any> = {}) {
  return fakeMigrationDb(seedMove(extra), { rpc: { transfer_portal_workspace_ownership: transfer, ensure_default_portal_workspace: ensureDefault, ...rpc } });
}

async function go(w: ReturnType<typeof world>, args: string[], deps: Record<string, unknown> = {}) {
  const h = harness();
  const files: Record<string, any> = {};
  const code = await run(["--target", "dev", ...args], {
    env: { ...DEV_ENV },
    db: w.db,
    log: h.log,
    report: h.report,
    writeFile: (path: string, value: unknown) => { files[path] = JSON.parse(JSON.stringify(value)); },
    readFile: (path: string) => JSON.stringify(files[path]),
    ...deps,
  });
  return { code, h, files };
}
const AMB = ["--owner-email", "ambika@example.com", "--label", "1. Ambika", "--journal-out", "/j/amb.json"];

/** What must be identical before and after: house, row and member counts per table, ignoring who owns them. */
function shape(w: ReturnType<typeof world>) {
  const t = w.tables;
  const rows = (name: string) => (t[name] ?? []).map((r) => ({ ...r, manager_user_id: undefined })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({
    houses: (t.manager_property_records ?? []).map((h) => [h.id, h.workspace_id]),
    leases: rows("portal_lease_pipeline_records"),
    charges: rows("portal_household_charge_records"),
    schedule: rows("portal_schedule_records"),
    apps: rows("manager_application_records"),
    convs: t.sms_projection_conversations,
  });
}

describe("move-plan: pure decisions", () => {
  it("reads a city from an explicit field, else from the address, else says it cannot", () => {
    expect(houseCity({ property_data: { address: "1 Pine St, Seattle, WA 98101" } })).toBe("Seattle");
    expect(houseCity({ property_data: { address: "3 Union St, seattle WA 98101-1234" } })).toBe("seattle");
    expect(houseCity({ property_data: { address: "5 Elm, Apt 2, Tacoma, WA" } })).toBe("Tacoma");
    expect(houseCity({ property_data: { listingSubmission: { city: "Seattle" } } })).toBe("Seattle");
    expect(houseCity({ property_data: { city: "Bellevue", address: "x, Seattle, WA 98101" } })).toBe("Bellevue");
    expect(houseCity({ property_data: { address: "somewhere in Seattle" } })).toBeNull();
    expect(houseCity({ property_data: {}, row_data: {} })).toBeNull();
  });

  it("a workspace is movable only when EVERY house is in the city", () => {
    const ws = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const h = (id: string, workspace_id: string, address: string) => ({ id, workspace_id, property_data: { address }, row_data: {} });
    const out = classifyWorkspaces(ws, [h("1", "a", "x, Seattle, WA 98101"), h("2", "b", "x, Seattle, WA 98101"), h("3", "b", "x, Tacoma, WA 98402"), h("4", "c", "x, Seattle, WA 98101"), { id: "5", workspace_id: "c", property_data: {}, row_data: {} }, h("6", "d", "x, Tacoma, WA 98402")], "Seattle");
    const by = Object.fromEntries(out.map((o: any) => [o.workspace.id, o]));
    expect(by.a).toMatchObject({ candidate: true, movable: true, mixed: false });
    expect(by.b).toMatchObject({ candidate: true, movable: false, mixed: true });
    expect(by.c).toMatchObject({ candidate: true, movable: false, mixed: true });
    expect(by.d).toMatchObject({ candidate: false, movable: false });
  });

  it("the admin stamp is the product's admin role stamp", () => {
    expect(ADMIN_STAMP).toEqual(stampTeamRolePermissions("admin"));
  });

  it("the re-keyed table lists match the transfer migration; nothing is in both lists", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261012121000_workspace_transfer_moves_work_identity.sql"), "utf8");
    const arrays = [...sql.matchAll(/array\[([\s\S]*?)\]/g)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(arrays[0]).toEqual([...MOVED_PROPERTY_TABLES]);
    expect(arrays[1]).toEqual([...MOVED_ASSIGNED_TABLES]);
    const unmoved = UNMOVED_PROPERTY_TABLES.map((u: any) => u.table);
    expect(unmoved.filter((t: string) => MOVED_PROPERTY_TABLES.includes(t))).toEqual([]);
    expect(new Set(unmoved).size).toBe(unmoved.length);
  });
});

describe("move-houses-to-service: guards and refusals", () => {
  it("needs a target, and an owner email (listing matches by name first)", async () => {
    const w = world();
    await expect(run([], { env: { ...DEV_ENV }, db: w.db, log: () => {} })).rejects.toThrow(/--target/);
    const h = harness();
    await expect(run(["--target", "dev", "--owner-name", "ambika"], { env: { ...DEV_ENV }, db: w.db, log: h.log })).rejects.toThrow(/--owner-email/);
    expect(h.text()).toMatch(/ambika@example.com/);
    expect(h.text()).not.toMatch(/vinod@example.com/);
    expect(w.writes).toEqual([]);
    await expect(go(w, ["--owner-email", "ambika@example.com"])).rejects.toThrow(/--label/);
  });

  it("dry run lists every house with its counts and writes nothing", async () => {
    const w = world();
    const { code, h } = await go(w, [...AMB, "--workspace-id", WA]);
    expect(code).toBe(0);
    expect(w.writes).toEqual([]);
    const text = h.text();
    expect(text).toMatch(/project=emstjswhotsnyksqhqyf/);
    expect(text).toMatch(/h1 {2}1 Pine St, Seattle, WA 98101 {2}\[live\] {2}residents 1, leases 1 \(open 1\), bookings 1 \(upcoming 1\), charges 2 \(open 1\)/);
    expect(text).toMatch(/h2 .*leases 1 \(open 0\).*applications 1/);
    expect(text).toMatch(/conversations 1/);
    expect(text).toMatch(/LEFT BEHIND/);
    expect(text).toMatch(/manager_sms_conversation_houses: 1/);
    expect(text).toMatch(/--apply --expect-houses 3 --acknowledge-unmoved/);
  });

  it("STOPS on a workspace that mixes cities, and never picks for you between two", async () => {
    const w = world();
    // Ambika has SEATTLE HOMES (all Seattle) and Mixed (Seattle + Tacoma): two candidates, so she must choose.
    await expect(go(w, AMB)).rejects.toThrow(/2 workspaces with Seattle houses/);
    await expect(go(w, [...AMB, "--workspace-id", WM])).resolves.toMatchObject({ code: 0 }); // explicit override skips the city gate
    const w2 = world({ portal_workspaces: seedMove().portal_workspaces!.filter((x) => x.id !== WA) });
    await expect(go(w2, AMB)).rejects.toThrow(/STOP: "Mixed" mixes cities/);
    expect(w2.writes).toEqual([]);
  });

  it("an unreadable address stops the run without an override; the override moves Vinod's empty draft", async () => {
    const w = world();
    await expect(go(w, ["--owner-email", "vinod@example.com", "--label", "2. Vinod"])).rejects.toThrow(/owns no workspace with a house in Seattle/);
    const { code, h } = await go(w, ["--owner-email", "vinod@example.com", "--label", "2. Vinod", "--workspace-id", WV]);
    expect(code).toBe(0);
    expect(h.text()).toMatch(/city check is SKIPPED/);
    const w3 = world({ manager_property_records: [...seedMove().manager_property_records!.filter((x) => x.id !== "h3"), { id: "h3", workspace_id: WA, manager_user_id: A, status: "draft", property_data: {}, row_data: {} }] });
    await expect(go(w3, [...AMB, "--workspace-id", WA]).then((r) => r.code)).resolves.toBe(0);
    await expect(go(w3, ["--owner-email", "ambika@example.com", "--label", "x", "--journal-out", "/j/x.json"])).rejects.toThrow(/pick one with --workspace-id|STOP/);
  });

  it("refuses an unknown or non-owner workspace id, the service owner, and a taken label", async () => {
    const w = world();
    await expect(go(w, [...AMB, "--workspace-id", WV])).rejects.toThrow(/not one of ambika@example.com's workspaces/);
    await expect(go(w, ["--owner-email", "admin@proplane.test", "--label", "x"])).rejects.toThrow(/service owner's own account/);
    await expect(go(w, ["--owner-email", "nobody@example.com", "--label", "x"])).rejects.toThrow(/No account has the email/);
    const taken = world({ portal_workspaces: [...seedMove().portal_workspaces!, { id: "t", owner_user_id: S, name: "1. ambika", is_default: false, is_service: true }] });
    await expect(go(taken, [...AMB, "--workspace-id", WA])).rejects.toThrow(/already has a workspace named/);
  });

  it("refuses without the W15 migration", async () => {
    const w = fakeMigrationDb(seedMove(), { missingTables: ["platform_service_settings"] });
    await expect(go(w as any, [...AMB, "--workspace-id", WA])).rejects.toThrow(/platform_service_settings does not exist/);
  });

  it("apply needs --expect-houses (the approved count) and --acknowledge-unmoved when rows are left behind", async () => {
    const w = world();
    await expect(go(w, [...AMB, "--workspace-id", WA, "--apply"])).rejects.toThrow(/--expect-houses 3/);
    await expect(go(w, [...AMB, "--workspace-id", WA, "--apply", "--expect-houses", "2"])).rejects.toThrow(/--expect-houses 3/);
    await expect(go(w, [...AMB, "--workspace-id", WA, "--apply", "--expect-houses", "3"])).rejects.toThrow(/left behind/);
    expect(w.writes).toEqual([]);
  });

  it("a production write needs the confirm ref, a reason, a fresh backup, and a backup taken for THIS owner", async () => {
    const w = world();
    const base = ["--target", "production", "--owner-email", "ambika@example.com", "--label", "1. Ambika", "--workspace-id", WA, "--apply", "--expect-houses", "3", "--acknowledge-unmoved", "--journal-out", "/j/p.json"];
    const deps = (move: unknown) => ({ env: { ...PROD_ENV }, db: w.db, log: () => {}, fsDeps: { exists: () => true, read: () => JSON.stringify({ meta: { kind: "one-number-backup", complete: true, ref: PROD_REF, createdAt: new Date().toISOString(), ...(move ? { move } : {}) } }) }, writeFile: () => {} });
    await expect(run(base, deps(null) as any)).rejects.toThrow(/--confirm-ref/);
    await expect(run([...base, "--confirm-ref", PROD_REF], deps(null) as any)).rejects.toThrow(/--reason/);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "move Ambika"], deps(null) as any)).rejects.toThrow(/--backup/);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "move Ambika", "--backup", "/b.json"], deps(null) as any)).rejects.toThrow(/not taken for this move/);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "move Ambika", "--backup", "/b.json"], deps({ ownerEmail: "vinod@example.com", workspaceIds: [WV] }) as any)).rejects.toThrow(/not taken for this move/);
    expect(w.writes).toEqual([]);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "move Ambika", "--backup", "/b.json"], deps({ ownerEmail: "ambika@example.com", workspaceIds: [WA] }) as any)).rejects.toThrow(/does not match|expects project/);
  });
});

describe("move-houses-to-service: apply, verify, undo, re-apply", () => {
  const APPLY = [...AMB, "--workspace-id", WA, "--apply", "--expect-houses", "3", "--acknowledge-unmoved"];

  it("moves the workspace through the app's transfer, keeps every count, and leaves the owner a default workspace", async () => {
    const w = world();
    const before = shape(w);
    const { code, files, h } = await go(w, APPLY);
    expect(h.text()).toMatch(/moved and verified/);
    expect(code).toBe(0);
    const t = w.tables;
    const ws: any = t.portal_workspaces.find((x) => x.id === WA);
    expect(ws).toMatchObject({ owner_user_id: S, is_service: true, name: "1. Ambika", city: "Seattle", is_default: false });
    expect(t.manager_property_records.filter((x) => x.workspace_id === WA).every((x) => x.manager_user_id === S)).toBe(true);
    expect(t.portal_lease_pipeline_records.filter((x) => ["l1", "l2"].includes(x.id as string)).every((x) => x.manager_user_id === S)).toBe(true);
    expect(t.portal_lease_pipeline_records.find((x) => x.id === "l3")!.manager_user_id).toBe(A); // the other workspace is untouched
    expect(t.manager_sms_numbers[0]!.manager_user_id).toBe(S);
    expect(shape(w)).toBe(before);
    // the former owner is an Admin member with the full stamp and is the owner of record; the co-manager stayed
    const links = t.account_link_invites;
    expect(links.find((x) => x.invitee_user_id === A)).toMatchObject({ inviter_user_id: S, team_role: "admin", status: "accepted", is_owner_of_record: true, co_manager_permissions: ADMIN_STAMP });
    expect(links.find((x) => x.invitee_user_id === "co-manager")).toMatchObject({ inviter_user_id: S, assigned_property_ids: ["h1"] });
    expect(links.find((x) => x.invitee_user_id === S)).toBeUndefined();
    // she still has exactly one default workspace
    expect(t.portal_workspaces.filter((x) => x.owner_user_id === A && x.is_default).length).toBe(1);
    expect(files["/j/amb.json"]).toMatchObject({ state: "applied", houseIds: ["h1", "h2", "h3"] });
    expect(files["/j/amb.json"].steps.map((s: any) => s.name)).toEqual(["service-owner-seated", "ownership-transferred", "marked-service", "default-workspace-created", "owner-of-record-set", "verified"]);
  });

  it("is safe to run again: it finds the finished move and writes nothing", async () => {
    const w = world();
    await go(w, APPLY);
    const writes = w.writes.length;
    const again = await go(w, APPLY);
    expect(again.code).toBe(0);
    expect(again.h.text()).toMatch(/Nothing to do/);
    expect(w.writes.length).toBe(writes);
  });

  it("undo transfers it back and proves every count, member, number and owner equals the snapshot; then re-apply works", async () => {
    const w = world();
    const snapshotTables = JSON.stringify(w.tables);
    const { files } = await go(w, APPLY);
    const dry = await go(w, ["--apply", "--undo", "/j/amb.json"].slice(1), { readFile: (p: string) => JSON.stringify(files[p]), writeFile: () => {} });
    expect(dry.h.text()).toMatch(/dry run/);
    const undo = await go(w, ["--apply", "--undo", "/j/amb.json"], { writeFile: (p: string, v: any) => { files[p] = JSON.parse(JSON.stringify(v)); }, readFile: (p: string) => JSON.stringify(files[p]) });
    expect(undo.h.text()).toMatch(/undone and verified/);
    expect(undo.code).toBe(0);
    expect(JSON.stringify(w.tables)).toBe(snapshotTables);
    expect(files["/j/amb.json"].state).toBe("undone");
    const second = await go(w, ["--apply", "--undo", "/j/amb.json"], { readFile: (p: string) => JSON.stringify(files[p]), writeFile: () => {} });
    expect(second.h.text()).toMatch(/already undone/);
    const again = await go(w, APPLY);
    expect(again.code).toBe(0);
    expect(w.tables.portal_workspaces.find((x) => x.id === WA)!.owner_user_id).toBe(S);
  });

  it("restores the default workspace and the cached work number on undo, and keeps a default that now holds data", async () => {
    const w = world();
    const { files } = await go(w, APPLY);
    const created = files["/j/amb.json"].createdDefaultId as string;
    w.tables.manager_property_records.push({ id: "new", workspace_id: created, manager_user_id: A, status: "draft", property_data: {}, row_data: {} });
    const undo = await go(w, ["--apply", "--undo", "/j/amb.json"], { readFile: (p: string) => JSON.stringify(files[p]), writeFile: () => {} });
    expect(undo.h.text()).toMatch(/now holds data; left in place/);
    expect(w.tables.portal_workspaces.find((x) => x.id === created)).toBeTruthy();
    expect(w.tables.portal_workspaces.find((x) => x.id === WA)!.is_default).toBe(false); // she has a default already
  });

  it("an error during the move undoes it and exits 1", async () => {
    const w = world({}, { ensure_default_portal_workspace: () => ({ data: null, error: { message: "boom" } }) });
    const before = JSON.stringify(w.tables);
    const { code, h, files } = await go(w, APPLY);
    expect(code).toBe(1);
    expect(h.text()).toMatch(/FAILED during the move: ensure_default_portal_workspace: boom\. Undoing\./);
    expect(h.text()).toMatch(/undone and verified/);
    expect(files["/j/amb.json"].state).toBe("undone");
    expect(JSON.stringify(w.tables)).toBe(before);
  });

  it("a transfer that silently moves nothing fails verification and is undone", async () => {
    const w = world({}, { transfer_portal_workspace_ownership: () => ({ data: { houses: 3, members: 1 }, error: null }) });
    const { code, h, files } = await go(w, APPLY);
    expect(code).toBe(1);
    expect(h.text()).toMatch(/CHECK FAILED/);
    expect(files["/j/amb.json"].state).toBe("undone");
    expect(w.tables.account_link_invites.some((x) => x.invitee_user_id === S)).toBe(false);
    expect(w.tables.portal_workspaces.find((x) => x.id === WA)).toMatchObject({ owner_user_id: A, is_service: false, name: "SEATTLE HOMES", is_default: true });
  });

  it("a verification mismatch is caught: a lease lost in the transfer", async () => {
    const lossy = (args: Record<string, any>, t: Record<string, FakeRow[]>) => {
      const r = transfer(args, t);
      t.portal_lease_pipeline_records.splice(0, 1);
      return r;
    };
    const w = world({}, { transfer_portal_workspace_ownership: lossy });
    const { code, h } = await go(w, APPLY);
    expect(code).toBe(1);
    expect(h.text()).toMatch(/portal_lease_pipeline_records\.count/);
  });

  it("undo refuses when the former owner was removed from the team (the app can only hand a workspace to a member)", async () => {
    const w = world();
    const { files } = await go(w, APPLY);
    w.tables.account_link_invites = w.tables.account_link_invites.filter((x) => x.invitee_user_id !== A);
    await expect(go(w, ["--apply", "--undo", "/j/amb.json"], { readFile: (p: string) => JSON.stringify(files[p]), writeFile: () => {} })).rejects.toThrow(/no longer an accepted member/);
    expect(w.tables.portal_workspaces.find((x) => x.id === WA)!.owner_user_id).toBe(S);
  });

  it("Vinod: an empty draft in his default workspace moves with an explicit --workspace-id", async () => {
    const w = world();
    const { code } = await go(w, ["--owner-email", "vinod@example.com", "--label", "2. Vinod", "--workspace-id", WV, "--apply", "--expect-houses", "1", "--journal-out", "/j/v.json"]);
    expect(code).toBe(0);
    expect(w.tables.portal_workspaces.find((x) => x.id === WV)).toMatchObject({ owner_user_id: S, is_service: true, name: "2. Vinod", is_default: false });
    expect(w.tables.portal_workspaces.filter((x) => x.owner_user_id === V && x.is_default).length).toBe(1);
    expect(w.tables.manager_property_records.find((x) => x.id === "d1")!.manager_user_id).toBe(S);
  });
});

describe("backup.mjs --owner-email", () => {
  it("saves the owner's rows and records which workspaces the backup covers", async () => {
    const w = world();
    const files: Record<string, any> = {};
    const h = harness();
    await backup(["--target", "dev", "--owner-email", "ambika@example.com", "--out", "/b/a.json"], { env: { ...DEV_ENV }, db: w.db, log: h.log, writeFile: (p: string, v: any) => { files[p] = v; } });
    const f = files["/b/a.json"];
    expect(f.meta.move).toMatchObject({ ownerEmail: "ambika@example.com", workspaceIds: [WA, WM] });
    expect(f.tables.move_manager_property_records.map((x: any) => x.id).sort()).toEqual(["h1", "h2", "h3", "m1", "m2"]);
    expect(f.tables.move_account_link_invites.length).toBe(1);
    expect(f.tables.move_owners["portal_lease_pipeline_records#property_id"].length).toBe(3);
    expect(f.tables.move_profile[0].sms_from_number).toBe("+12065550111");
  });

  it("a backup without --owner-email carries no move section", async () => {
    const w = world();
    const files: Record<string, any> = {};
    await backup(["--target", "dev", "--out", "/b/a.json"], { env: { ...DEV_ENV }, db: w.db, log: () => {}, writeFile: (p: string, v: any) => { files[p] = v; } });
    expect(files["/b/a.json"].meta.move).toBeUndefined();
  });
});
