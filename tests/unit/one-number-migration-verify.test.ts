/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
import { describe, expect, it } from "vitest";
import { run as backfill } from "../../scripts/one-number/backfill.mjs";
import { run, unresolvedKeys } from "../../scripts/one-number/verify.mjs";
import { DEV_ENV, O1, O2, WS1, WS2, harness, world } from "./one-number-migration-fixtures";

const SID = "MG" + "a".repeat(32);

async function verify(db: never, args: string[] = [], deps: Record<string, unknown> = {}) {
  const h = harness();
  const code = await run(["--target", "dev", ...args], { env: DEV_ENV, db, log: h.log, report: h.report, ...deps });
  return { code, h, results: h.report.results as { name: string; ok: boolean; failures: string[]; warnings: string[] }[] };
}
const named = (results: { name: string; ok: boolean }[], name: string) => results.find((r) => r.name === name)!;

async function migrated() {
  const w = world();
  const baseline: any[] = [];
  await verify(w.db, ["--save-baseline", "b.json"], { writeFile: (_p: string, v: unknown) => baseline.push(v) });
  await backfill(["--target", "dev", "--apply"], { env: DEV_ENV, db: w.db, log: () => {}, writeFile: () => {} });
  return { w, baseline: baseline[0] };
}

describe("verify.mjs", () => {
  it("passes after a clean backfill and fails before it", async () => {
    const before = world();
    const pre = await verify(before.db);
    expect(pre.code).toBe(1);
    expect(named(pre.results, "stamps:sms_projection_turns").ok).toBe(false);

    const { w, baseline } = await migrated();
    const post = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(post.h.text()).toMatch(/checks passed|FAILED/);
    expect(post.results.filter((r) => !r.ok).map((r) => r.name)).toEqual([]);
    expect(post.code).toBe(0);
  });

  it("writes nothing to the database", async () => {
    const { w, baseline } = await migrated();
    w.writes.length = 0;
    await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(w.writes).toEqual([]);
  });

  it("saves a baseline with the ids and counts it will later compare", async () => {
    const w = world({ sms_consent: [{ phone: "2065550142", opted_in_at: null, opted_out_at: "2026-09-01T00:00:00Z" }] });
    const saved: any[] = [];
    await verify(w.db, ["--save-baseline", "b.json"], { writeFile: (_p: string, v: unknown) => saved.push(v) });
    expect(saved[0]).toMatchObject({ kind: "one-number-verify-baseline", ref: "emstjswhotsnyksqhqyf", turnCount: 3, optedOutKeys: ["2065550142"] });
    expect(saved[0].conversationIds).toHaveLength(3);
  });

  it("fails when a baseline conversation or turn disappears", async () => {
    const { w, baseline } = await migrated();
    (w.tables.sms_projection_conversations as any[]).pop();
    (w.tables.sms_projection_turns as any[]).pop();
    const out = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(named(out.results, "counts").ok).toBe(false);
    expect(named(out.results, "counts").failures.join(" ")).toMatch(/gone.*turns fell|turns fell/);
    expect(out.code).toBe(1);
  });

  it("allows new live traffic unless --strict-counts", async () => {
    const { w, baseline } = await migrated();
    (w.tables.sms_projection_turns as any[]).push({ id: "t-new", owner_manager_user_id: O1, conversation_id: "conv-1", workspace_id: WS1 });
    expect(named((await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) })).results, "counts").ok).toBe(true);
    expect(named((await verify(w.db, ["--baseline", "b.json", "--strict-counts"], { readFile: () => JSON.stringify(baseline) })).results, "counts").ok).toBe(false);
  });

  it("fails a stampable row left without a workspace; rows that cannot be stamped are a note, or a failure with --strict-orphans", async () => {
    const { w, baseline } = await migrated();
    (w.tables.sms_outbox as any[]).push({ id: "late", manager_user_id: O2, selected_work_line_id: null, workspace_id: null });
    const bad = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(named(bad.results, "stamps:sms_outbox").ok).toBe(false);
    (w.tables.sms_outbox as any[]).pop();
    const ok = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(named(ok.results, "stamps:sms_outbox")).toMatchObject({ ok: true });
    expect(named(ok.results, "stamps:sms_outbox").warnings.join(" ")).toMatch(/cannot be stamped/);
    const strict = await verify(w.db, ["--baseline", "b.json", "--strict-orphans"], { readFile: () => JSON.stringify(baseline) });
    expect(named(strict.results, "stamps:sms_outbox").ok).toBe(false);
  });

  it("fails when a baseline opt-out is gone, and when a scoped revoke is not carried to the shared service", async () => {
    const w = world({ sms_consent: [{ phone: "2065550142", opted_in_at: null, opted_out_at: "2026-09-01T00:00:00Z" }] });
    const saved: any[] = [];
    await verify(w.db, ["--save-baseline", "b.json"], { writeFile: (_p: string, v: unknown) => saved.push(v) });
    (w.tables.sms_consent as any[])[0].opted_in_at = "2026-10-01T00:00:00Z";
    const lost = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(saved[0]) });
    expect(named(lost.results, "optouts").failures.join(" ")).toMatch(/no longer opted out/);

    const w2 = world({
      sms_consent_events: [{ id: "e", recipient_phone_key: "2065550142", manager_user_id: O1, messaging_service_sid: "MG" + "b".repeat(32), purpose: "p", send_class: "automated", conversation_key: null, event_type: "revoked", occurred_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }],
    });
    const scoped = await verify(w2.db, ["--service-sid", SID]);
    expect(named(scoped.results, "optouts").failures.join(" ")).toMatch(/not carried onto/);
    await backfill(["--target", "dev", "--apply", "--only", "consent", "--service-sid", SID], { env: DEV_ENV, db: w2.db, log: () => {}, writeFile: () => {} });
    expect(named((await verify(w2.db, ["--service-sid", SID])).results, "optouts").ok).toBe(true);
  });

  it("resolves old keys through a conversation's legacy key or an alias, and only fails a NEW regression", async () => {
    const w = world();
    expect((await unresolvedKeys(w.db)).unresolved).toEqual([]);
    (w.tables.sms_projection_aliases as any[]).length = 0;
    // A key whose conversation row is gone and which has no alias.
    (w.tables.manager_sms_messages as any[]).push({ id: "m9", manager_user_id: O1, direction: "inbound", from_phone: "", to_phone: "", resident_phone: "", conversation_key: "k-lost", workspace_id: WS1 });
    const first = await verify(w.db);
    expect(named(first.results, "aliases").failures.join(" ")).toMatch(/k-lost/);
    const asBaseline = { kind: "one-number-verify-baseline", ref: "emstjswhotsnyksqhqyf", conversationIds: [], contactIds: [], turnCount: 0, optedOutKeys: [], unresolvedKeys: [`${O1}|k-lost`] };
    const second = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(asBaseline) });
    expect(named(second.results, "aliases").ok).toBe(true);
    expect(named(second.results, "aliases").warnings.join(" ")).toMatch(/before the migration/);
  });

  it("flags a row stamped into another owner's workspace", async () => {
    const { w, baseline } = await migrated();
    byId(w.tables.manager_sms_messages as any[], "m1").workspace_id = WS2;
    const out = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify(baseline) });
    expect(named(out.results, "isolation").ok).toBe(false);
    expect(named(out.results, "isolation").failures[0]).toMatch(/manager_sms_messages m1/);
  });

  it("flags a contact tied to a user whose phone differs or is unverified", async () => {
    const w = world({
      sms_phone_contacts: [
        { phone_e164: "+12065550142", phone_key: "2065550142", user_id: "u-ven" },
        { phone_e164: "+12065550177", phone_key: "2065550177", user_id: "u-ven" },
      ],
    });
    const out = await verify(w.db);
    const failures = named(out.results, "contacts").failures.join(" | ");
    expect(failures).toMatch(/phone differs/);
    expect(failures).toMatch(/unverified/);
  });

  it("refuses a baseline taken on another project", async () => {
    const w = world();
    const out = await verify(w.db, ["--baseline", "b.json"], { readFile: () => JSON.stringify({ ref: "qahnczmilgptcedaqype" }) });
    expect(out.code).toBe(2);
  });

  it("reports an unmigrated stamp column as a failure, not a crash", async () => {
    const w = world({}, { missingColumns: { inbound_sms_log: ["workspace_id"] } });
    const out = await verify(w.db);
    expect(named(out.results, "stamps:inbound_sms_log").failures[0]).toMatch(/migration not run/);
  });
});

function byId(rows: any[], id: string) {
  return rows.find((r) => r.id === id);
}
