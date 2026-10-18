/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
import { describe, expect, it } from "vitest";
import { planAliases, planContacts, planScopedOptOuts, run } from "../../scripts/one-number/backfill.mjs";
import { buildWorkspaceIndex, planStamps, STAMP_TABLES } from "../../scripts/one-number/lib/stamp-plan.mjs";
import {
  CONV1, CONV2, DEV_ENV, N1, N2, O1, O2, O3, PROD_ENV, PROD_REF, WS1, WS1B, WS2, harness, world,
} from "./one-number-migration-fixtures";

const SID = "MG" + "a".repeat(32);
const OLD_SID = "MG" + "b".repeat(32);

async function go(db: never, args: string[] = [], deps: Record<string, unknown> = {}) {
  const h = harness();
  const journal: any[] = [];
  const code = await run(["--target", "dev", ...args], { env: DEV_ENV, db, log: h.log, report: h.report, writeFile: (_p: string, v: unknown) => journal.push(v), ...deps });
  return { code, h, journal: journal[0] };
}
const byId = (rows: any[], key: string, id: string) => rows.find((r) => r[key] === id);

describe("backfill dry run", () => {
  it("plans everything and writes nothing", async () => {
    const { db, writes } = world();
    const { code, h, journal } = await go(db);
    expect(code).toBe(0);
    expect(writes).toEqual([]);
    expect(journal).toBeUndefined();
    expect(h.text()).toMatch(/dry run, nothing written/);
    expect(h.report.contacts.planned).toBe(4);
    expect(h.report.stamps.sms_projection_turns.planned).toBe(2);
  });
});

describe("backfill --apply", () => {
  it("adds one global contact per phone; a user only when exactly one verified account holds it", async () => {
    const { db, tables } = world();
    await go(db, ["--apply", "--only", "contacts"]);
    const rows = tables.sms_phone_contacts as any[];
    expect(rows.map((r) => r.phone_e164).sort()).toEqual(["+12065550142", "+12065550177", "+12065550188", "+12065550999"]);
    expect(byId(rows, "phone_e164", "+12065550142")).toMatchObject({ phone_key: "2065550142", user_id: "u-res", display_name: "Rae R" });
    // Unverified phone: no user. Two accounts on one phone: nobody.
    expect(byId(rows, "phone_e164", "+12065550177")).toMatchObject({ user_id: null, display_name: "Vic Vendor" });
    expect(byId(rows, "phone_e164", "+12065550188").user_id).toBeNull();
    expect(byId(rows, "phone_e164", "+12065550999").display_name).toBeNull();
  });

  it("never re-adds or edits an existing contact", async () => {
    const { db, tables } = world({ sms_phone_contacts: [{ phone_e164: "+12065550142", phone_key: "2065550142", user_id: null, display_name: "Edited" }] });
    await go(db, ["--apply", "--only", "contacts"]);
    expect(byId(tables.sms_phone_contacts as any[], "phone_e164", "+12065550142")).toMatchObject({ display_name: "Edited", user_id: null });
    expect(tables.sms_phone_contacts).toHaveLength(4);
  });

  it("aliases every legacy key, pointing a merged conversation's key at its survivor", async () => {
    const { db, tables } = world();
    await go(db, ["--apply", "--only", "aliases"]);
    const aliases = tables.sms_projection_aliases as any[];
    expect(aliases.map((a) => `${a.alias_value}>${a.conversation_id}`).sort()).toEqual([`k-old-1>${CONV1}`, `k-old-2>${CONV2}`, `k-old-3>${CONV1}`]);
    expect(aliases.every((a) => a.alias_kind === "legacy_key")).toBe(true);
  });

  it("stamps from the conversation, the work line, the number, then the owner's default, and only with a workspace the row's owner holds", async () => {
    const { db, tables } = world();
    const { h } = await go(db, ["--apply", "--only", "stamps"]);
    const ws = (table: string, key: string, id: string) => byId(tables[table] as any[], key, id).workspace_id;
    // The number N1 lives in O1's SECOND workspace, so its traffic follows it there, not to the default.
    expect(ws("sms_projection_turns", "id", "t1")).toBe(WS1B);
    expect(ws("sms_projection_turns", "id", "t2")).toBe(WS2);
    expect(ws("sms_projection_turns", "id", "t3")).toBe(WS1); // already stamped: untouched
    expect(ws("sms_outbox", "id", "o1")).toBe(WS1B);
    expect(ws("sms_outbox", "id", "o2")).toBe(WS2);
    expect(ws("sms_outbox", "id", "o3")).toBeNull(); // owner holds no workspace
    expect(ws("sms_inbound_receipts", "message_sid", "SM1")).toBe(WS1);
    expect(ws("sms_inbound_receipts", "message_sid", "SM2")).toBe(WS2);
    expect(ws("sms_inbound_receipts", "message_sid", "SM3")).toBe(WS1); // payload named someone else's workspace
    expect(ws("manager_sms_messages", "id", "m1")).toBe(WS1B);
    expect(ws("manager_sms_messages", "id", "m2")).toBe(WS2);
    expect(ws("inbound_sms_log", "id", "l1")).toBe(WS1B);
    expect(ws("inbound_sms_log", "id", "l2")).toBeNull(); // no owner at all
    // A contact lands where its thread lives.
    expect(ws("manager_sms_contacts", "id", "c1")).toBe(WS1B);
    expect(ws("manager_sms_contacts", "id", "c2")).toBe(WS2);
    expect(h.text()).toMatch(/left \(\{"owner_has_no_workspace":1\}\)/);
  });

  it("does not stamp conversations unless asked", async () => {
    const a = world();
    await go(a.db, ["--apply", "--only", "stamps"]);
    expect((a.tables.sms_projection_conversations as any[]).every((c) => c.workspace_id === null)).toBe(true);
    const b = world();
    await go(b.db, ["--apply", "--only", "stamps", "--stamp-conversations"]);
    expect(byId(b.tables.sms_projection_conversations as any[], "id", CONV1).workspace_id).toBe(WS1B);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const w = world();
    await go(w.db, ["--apply"]);
    w.writes.length = 0;
    const again = await go(w.db, ["--apply"]);
    expect(again.code).toBe(0);
    expect(w.writes.filter((x) => x.count > 0)).toEqual([]);
    expect(again.journal.contacts).toEqual([]);
    expect(again.journal.aliases).toEqual([]);
  });

  it("only fills NULL stamps: a row stamped meanwhile keeps its stamp", async () => {
    const w = world();
    const t1 = (w.tables.sms_projection_turns as any[])[0];
    // The planner saw t1 unstamped; by the time the write lands somebody stamped it. The update repeats `is null`.
    const originalFrom = (w.db as any).from.bind(w.db);
    (w.db as any).from = (table: string) => {
      const builder = originalFrom(table);
      if (table === "sms_projection_turns") {
        const update = builder.update.bind(builder);
        builder.update = (patch: any) => { t1.workspace_id = WS1; return update(patch); };
      }
      return builder;
    };
    await go(w.db, ["--apply", "--only", "stamps"]);
    expect(t1.workspace_id).toBe(WS1);
  });

  it("never moves a row across owners, even when a number is shared into another owner's workspace", async () => {
    const w = world({
      manager_sms_numbers: [
        { id: "num-x", manager_user_id: O2, workspace_id: WS1, phone_number: "+12065550333", provision_state: "active", released_at: null },
      ],
      sms_outbox: [{ id: "ox", manager_user_id: O2, selected_work_line_id: "num-x", provider_from_phone: null, transport_from_number: null, workspace_id: null }],
    });
    await go(w.db, ["--apply", "--only", "stamps"]);
    // num-x's home workspace WS1 belongs to O1; O2's own text lands in O2's workspace.
    expect(byId(w.tables.sms_outbox as any[], "id", "ox").workspace_id).toBe(WS2);
  });

  it("follows a number linked into the owner's workspace through workspace_work_numbers", async () => {
    const w = world({
      manager_sms_numbers: [{ id: "num-y", manager_user_id: O1, workspace_id: null, phone_number: "+12065550444", provision_state: "active", released_at: null }],
      workspace_work_numbers: [{ workspace_id: WS1B, number_id: "num-y", is_primary: true }],
      sms_outbox: [{ id: "oy", manager_user_id: O1, selected_work_line_id: "num-y", provider_from_phone: null, transport_from_number: null, workspace_id: null }],
    });
    await go(w.db, ["--apply", "--only", "stamps"]);
    expect(byId(w.tables.sms_outbox as any[], "id", "oy").workspace_id).toBe(WS1B);
  });

  it("skips a table whose workspace_id column is not migrated and says so", async () => {
    const w = world({}, { missingColumns: { sms_outbox: ["workspace_id"] } });
    const { code, h } = await go(w.db, ["--apply", "--only", "stamps"]);
    expect(code).toBe(0);
    expect(h.text()).toMatch(/sms_outbox has no workspace_id here/);
    expect(byId(w.tables.sms_projection_turns as any[], "id", "t2").workspace_id).toBe(WS2);
  });

  it("skips contacts when sms_phone_contacts is not migrated", async () => {
    const w = world({}, { missingTables: ["sms_phone_contacts"] });
    const { code, h } = await go(w.db, ["--apply", "--only", "contacts"]);
    expect(code).toBe(0);
    expect(h.text()).toMatch(/not migrated here/);
  });
});

describe("backfill: scoped opt-outs", () => {
  const ev = (over: Record<string, unknown>) => ({
    id: `e${Math.random()}`, recipient_phone_key: "2065550142", manager_user_id: O1, messaging_service_sid: OLD_SID, purpose: "resident_agent", send_class: "automated",
    conversation_key: null, event_type: "revoked", wording_version: null, occurred_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", ...over,
  });

  it("copies a revoke onto the shared service and never copies a grant", async () => {
    const w = world({ sms_consent_events: [ev({}), ev({ recipient_phone_key: "2065550177", event_type: "granted" })] });
    const { h } = await go(w.db, ["--apply", "--only", "consent", "--service-sid", SID]);
    const rows = w.tables.sms_consent_events as any[];
    const copied = rows.filter((r) => r.messaging_service_sid === SID);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ recipient_phone_key: "2065550142", event_type: "revoked", manager_user_id: O1, source: "one_number_migration", occurred_at: "2026-09-01T00:00:00Z" });
    expect(h.report.consent.written).toBe(1);
  });

  it("leaves a revoke alone when the shared scope already revoked or the person re-granted there later", () => {
    const events = [
      ev({ id: "a" }),
      ev({ id: "a2", messaging_service_sid: SID, occurred_at: "2026-09-02T00:00:00Z" }),
      ev({ id: "b", recipient_phone_key: "2065550177" }),
      ev({ id: "b2", recipient_phone_key: "2065550177", messaging_service_sid: SID, event_type: "granted", occurred_at: "2026-09-03T00:00:00Z" }),
    ];
    expect(planScopedOptOuts({ events, sharedSid: SID })).toMatchObject({ inserts: [], alreadyCovered: 2 });
  });

  it("copies when the latest evidence across services is a revoke, not an older one", () => {
    const events = [
      ev({ id: "g", event_type: "granted", occurred_at: "2026-08-01T00:00:00Z" }),
      ev({ id: "r", occurred_at: "2026-09-01T00:00:00Z" }),
      ev({ id: "g2", messaging_service_sid: "MG" + "c".repeat(32), event_type: "granted", occurred_at: "2026-07-01T00:00:00Z" }),
    ];
    expect(planScopedOptOuts({ events, sharedSid: SID }).inserts).toHaveLength(1);
    const reGranted = [...events, ev({ id: "g3", event_type: "granted", occurred_at: "2026-10-01T00:00:00Z" })];
    expect(planScopedOptOuts({ events: reGranted, sharedSid: SID }).inserts).toHaveLength(0);
  });

  it("skips a revoke whose phone is opted out globally: that block is phone-wide and a START lifts it", async () => {
    const w = world({
      sms_consent_events: [ev({}), ev({ recipient_phone_key: "2065550177", manager_user_id: O2 })],
      sms_consent: [{ phone: "2065550142", opted_in_at: null, opted_out_at: "2026-09-01T00:00:00Z" }],
    });
    const { h } = await go(w.db, ["--apply", "--only", "consent", "--service-sid", SID]);
    const copied = (w.tables.sms_consent_events as any[]).filter((r) => r.messaging_service_sid === SID);
    expect(copied.map((r) => r.recipient_phone_key)).toEqual(["2065550177"]); // the scoped-only withdrawal
    expect(h.report.consent).toMatchObject({ planned: 1, coveredByGlobal: 1 });
    // The person who STOPped globally then texts START: nothing scoped is left to outlive it.
    (w.tables.sms_consent as any[])[0].opted_in_at = "2026-10-05T00:00:00Z";
    expect((w.tables.sms_consent_events as any[]).some((r) => r.recipient_phone_key === "2065550142" && r.messaging_service_sid === SID)).toBe(false);
  });

  it("is skipped, loudly, without a shared service SID", async () => {
    const w = world({ sms_consent_events: [ev({})] });
    const { h } = await go(w.db, ["--apply", "--only", "consent"]);
    expect(h.text()).toMatch(/scoped copy SKIPPED/);
    expect(w.tables.sms_consent_events).toHaveLength(1);
  });

  it("reads the SID from sms_runtime_config when the flag is absent", async () => {
    const w = world({
      sms_consent_events: [ev({})],
      sms_runtime_config: [{ singleton: true, line_mode: "shadow", shared_number_e164: "+12065550100", shared_messaging_service_sid: SID, shared_pilot_workspace_ids: [] }],
    });
    await go(w.db, ["--apply", "--only", "consent"]);
    expect((w.tables.sms_consent_events as any[]).filter((r) => r.messaging_service_sid === SID)).toHaveLength(1);
  });
});

describe("backfill --undo", () => {
  it("takes back exactly what the journal recorded", async () => {
    const w = world({ sms_consent_events: [{ id: "e0", recipient_phone_key: "2065550142", manager_user_id: O1, messaging_service_sid: OLD_SID, purpose: "p", send_class: "automated", conversation_key: null, event_type: "revoked", occurred_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }] });
    const applied = await go(w.db, ["--apply", "--service-sid", SID]);
    expect((w.tables.sms_phone_contacts as any[]).length).toBe(4);
    const undone = await go(w.db, ["--apply", "--undo", "journal.json"], { readFile: () => JSON.stringify(applied.journal) });
    expect(undone.code).toBe(0);
    expect(w.tables.sms_phone_contacts).toHaveLength(0);
    expect(w.tables.sms_projection_aliases).toHaveLength(0);
    expect(w.tables.sms_consent_events).toHaveLength(1);
    expect((w.tables.sms_projection_turns as any[]).map((t) => t.workspace_id)).toEqual([null, null, WS1]);
    expect(byId(w.tables.sms_outbox as any[], "id", "o1").workspace_id).toBeNull();
  });

  it("leaves a stamp alone that was legitimately changed after the backfill", async () => {
    const w = world();
    const applied = await go(w.db, ["--apply", "--only", "stamps"]);
    byId(w.tables.sms_outbox as any[], "id", "o1").workspace_id = WS1; // re-stamped by the product since
    await go(w.db, ["--apply", "--undo", "j"], { readFile: () => JSON.stringify(applied.journal) });
    expect(byId(w.tables.sms_outbox as any[], "id", "o1").workspace_id).toBe(WS1);
  });

  it("without --apply is a no-op", async () => {
    const w = world();
    const { h } = await go(w.db, ["--undo", "j"], { readFile: () => "{}" });
    expect(h.text()).toMatch(/Dry run: nothing changed/);
    expect(w.writes).toEqual([]);
  });

  it("refuses a journal from another project or another kind of file", async () => {
    const w = world();
    await expect(go(w.db, ["--apply", "--undo", "j"], { readFile: () => JSON.stringify({ kind: "nope" }) })).rejects.toThrow(/not a backfill journal/);
    await expect(go(w.db, ["--apply", "--undo", "j"], { readFile: () => JSON.stringify({ kind: "one-number-backfill-journal", ref: PROD_REF }) })).rejects.toThrow(/for project/);
  });
});

describe("backfill guards", () => {
  it("refuses a production write without the full set of guards, before touching anything", async () => {
    const w = world();
    const base = ["--target", "production", "--apply"];
    const deps = { env: PROD_ENV, db: w.db, log: () => {}, writeFile: () => {} };
    await expect(run(base, deps)).rejects.toThrow(/confirm-ref/);
    await expect(run([...base, "--confirm-ref", PROD_REF], deps)).rejects.toThrow(/reason/);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "the real cutover run"], deps)).rejects.toThrow(/--backup/);
    await expect(run([...base, "--confirm-ref", PROD_REF, "--reason", "the real cutover run", "--backup", "/nope.json"], deps)).rejects.toThrow(/not found/);
    expect(w.writes).toEqual([]);
    expect(w.reads).toEqual([]);
  });

  it("with every guard, a production dry run is still read-only", async () => {
    const w = world();
    const code = await run(["--target", "production", "--confirm-ref", PROD_REF], { env: PROD_ENV, db: w.db, log: () => {} });
    expect(code).toBe(0);
    expect(w.writes).toEqual([]);
  });

  it("rejects an unknown --only part", async () => {
    await expect(go(world().db, ["--only", "nonsense"])).rejects.toThrow(/unknown part/);
  });
});

describe("pure planners", () => {
  it("planContacts counts unusable numbers and ambiguous accounts", () => {
    const plan = planContacts({
      profiles: [{ id: "a", phone: "12", phone_verified_at: null, full_name: "x" }, { id: "b", phone: "+12065550000", phone_verified_at: "t", full_name: "B" }],
      managerContacts: [],
      existing: [],
    });
    expect(plan.invalid).toBe(1);
    expect(plan.inserts).toEqual([{ phone_e164: "+12065550000", phone_key: "2065550000", user_id: "b", display_name: "B" }]);
  });

  it("planAliases skips a conversation with no legacy key", () => {
    const plan = planAliases({
      conversations: [{ id: "c", owner_manager_user_id: "o", counterparty_role: "resident", work_line_id: "w", legacy_conversation_key: null, merged_into_id: null }],
      aliases: [],
    });
    expect(plan).toMatchObject({ inserts: [], noKey: 1 });
  });

  it("planStamps reports a row it cannot place instead of guessing", () => {
    const index = buildWorkspaceIndex({ workspaces: [], numbers: [], links: [] });
    const spec = STAMP_TABLES.find((s: any) => s.table === "sms_outbox");
    const out = planStamps(spec, [{ id: "x", manager_user_id: O3, selected_work_line_id: null }, { id: "y", manager_user_id: null }], { index, conversations: new Map(), contactWorkspace: new Map() });
    expect(out.updates).toEqual([]);
    expect(out.skipped.map((s: any) => s.reason).sort()).toEqual(["no_owner", "owner_has_no_workspace"]);
  });

  it("falls back to the earliest workspace when an owner has no default", () => {
    const index = buildWorkspaceIndex({
      workspaces: [
        { id: "late", owner_user_id: "o", is_default: false, created_at: "2026-05-01" },
        { id: "early", owner_user_id: "o", is_default: false, created_at: "2026-01-01" },
      ],
    });
    expect(index.ownerDefault("o")).toBe("early");
    expect(index.workspaceCount("o")).toBe(2);
    expect(index.workspaceForNumberId("o", N1)).toBeNull();
    expect(index.workspaceForPhone("o", "+12065550111")).toBeNull();
    expect(N2).toBe("num-2");
  });
});
