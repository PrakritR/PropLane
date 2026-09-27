import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { runBackfill, mapBounded } = await import(new URL("../../scripts/backfill-sms-projection.mjs", import.meta.url).href);
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SID = "SM-original";
const AT = "2026-09-25T12:00:00.000Z";
const FROM = "+12065552222";
const TO = "+12065559999";
const BODY = "😀".repeat(2001) + " full tail ";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Row = Record<string, unknown>;
function fixture({ failLog = false, missingOriginal = false, payloadOnly = false, badPayload = false, pendingLog = false,
  retained = false, retainedLookupError = false } = {}) {
  const tables: Record<string, Row[]> = {
    prospect_sms_ingress: [{ source_message_id: SID, manager_user_id: B, channel: "twilio",
      body: Array.from(BODY.trim()).slice(0, 2000).join(""), received_at: "2026-09-25T12:00:08.000Z", burst_id: "burst-1", burst_revision: 1 }],
    prospect_sms_bursts: [{ id: "burst-1", manager_user_id: B, counterparty_phone_e164: FROM,
      reply_from_number: TO, counterparty_role: "prospect", channel: "sms" }],
    sms_inbound_receipts: [{ message_sid: SID, manager_user_id: A, status: "completed", first_received_at: AT,
      inbound_payload: payloadOnly ? (badPayload ? { fromPhone: FROM, toPhone: TO } : { body: BODY, fromPhone: FROM, toPhone: TO }) : null }],
    inbound_sms_log: [{ id: "33333333-3333-4333-8333-333333333333", manager_user_id: A,
      from_phone: FROM, to_phone: TO, matched_sender_user_id: null, body: BODY,
      message_sid: SID, created_at: "2026-09-25T12:00:01.000Z", counterparty_role: "prospect", conversation_key: `${A}:prospect:${FROM}` }],
    manager_sms_numbers: [{ id: "line-1", manager_user_id: A, workspace_id: "workspace-1",
      phone_number: TO, provision_state: "active", requested_at: "2026-09-01T00:00:00.000Z",
      provisioned_at: "2026-09-01T00:00:00.000Z", released_at: null }],
    portal_workspaces: [{ id: "workspace-1", owner_user_id: B }],
    manager_sms_messages: [], sms_relay_messages: [], portal_inbox_thread_records: [],
    sms_projection_turns: [], sms_projection_conversations: [], sms_projection_deleted_events: [],
    sms_projection_cutover: [{ singleton: true, ready: false }],
  };
  if (payloadOnly || pendingLog) {
    tables.prospect_sms_ingress = [];
    tables.prospect_sms_bursts = [];
    if (payloadOnly) tables.inbound_sms_log = [];
    if (pendingLog) {
      tables.sms_inbound_receipts[0].status = "retryable";
      tables.inbound_sms_log[0].counterparty_role = "resident";
      tables.inbound_sms_log[0].conversation_key = "retained-opaque-key";
    }
    tables.portal_workspaces[0].owner_user_id = A;
  }
  if (retained) {
    tables.prospect_sms_ingress = [];
    tables.prospect_sms_bursts = [];
    tables.manager_sms_numbers = [];
    tables.inbound_sms_log[0].manager_user_id = B;
    tables.inbound_sms_log[0].created_at = "2026-09-02T20:20:41.259580Z";
    tables.inbound_sms_log[0].conversation_key = `${B}:prospect:${FROM}`;
    tables.manager_sms_messages = [{ id: "44444444-4444-4444-8444-444444444444", manager_user_id: B,
      resident_user_id: null, resident_phone: FROM, direction: "inbound", body: BODY,
      from_phone: FROM, to_phone: TO, message_sid: SID, source: "work_number",
      created_at: "2026-09-02T20:20:41.117906Z", counterparty_role: "prospect", conversation_key: `${B}:prospect:${FROM}` }];
    tables.sms_inbound_receipts[0].first_received_at = "2026-09-02T20:20:40.000000Z";
  }
  let originalCalls = 0;
  let retainedImports = 0;
  let retainedLookups = 0;
  const db = {
    from(table: string) {
      const conditions: Array<(row: Row) => boolean> = [];
      const orders: string[] = [];
      let max = Infinity;
      let update: Row | null = null;
      const q: Row = {
        select: () => q,
        eq: (key: string, value: unknown) => { conditions.push((r) => r[key] === value); return q; },
        not: (key: string, op: string) => { if (op === "is") conditions.push((r) => r[key] !== null && r[key] !== undefined); return q; },
        in: (key: string, values: unknown[]) => { conditions.push((r) => values.includes(r[key])); return q; },
        or: () => q,
        order: (key: string) => { orders.push(key); return q; },
        limit: (value: number) => { max = value; return q; },
        update: (value: Row) => { update = value; return q; },
        then(resolve: (value: Row) => unknown) {
          let rows = (tables[table] ?? []).filter((row) => conditions.every((f) => f(row)));
          if (update) for (const row of rows) Object.assign(row, update);
          if (orders.length) rows = [...rows].sort((x, y) => {
            for (const key of orders) { const diff = String(x[key]).localeCompare(String(y[key])); if (diff) return diff; }
            return 0;
          });
          return Promise.resolve({ data: rows.slice(0, max), error: null }).then(resolve);
        },
      };
      return q;
    },
    async rpc(name: string, args: Row) {
      if (name === "resolve_sms_retained_historical_source") {
        retainedLookups += 1;
        if (retainedLookupError) return { data: null, error: { code: "P0001" } };
        if (!retained) return { data: { eligible: false, reason: "fingerprint_mismatch" }, error: null };
        return { data: { eligible: true, sourceTable: "inbound_sms_log", sourceId: tables.inbound_sms_log[0].id,
          mirrorId: tables.manager_sms_messages[0].id, owner: B, receiptOwner: A,
          role: "prospect", userId: null, sid: SID, body: BODY, fromPhone: FROM, toPhone: TO,
          occurredAt: tables.inbound_sms_log[0].created_at, mirrorAt: tables.manager_sms_messages[0].created_at,
          fingerprint: "a".repeat(64) }, error: null };
      }
      if (name === "import_sms_retained_historical_source") {
        retainedImports += 1;
        const prior = tables.sms_projection_turns.find((row) => row.provider_sid === SID);
        if (!prior) {
          const id = String(tables.inbound_sms_log[0].id);
          const lineHash = (await import("node:crypto")).createHash("md5").update(`retained:inbound_sms_log:${B}:${id}`).digest("hex");
          const line = `${lineHash.slice(0, 8)}-${lineHash.slice(8, 12)}-${lineHash.slice(12, 16)}-${lineHash.slice(16, 20)}-${lineHash.slice(20, 32)}`;
          tables.sms_projection_conversations.push({ id: "retained-conversation", owner_manager_user_id: B,
            counterparty_role: "prospect", work_line_id: line, identity_kind: "unresolved",
            identity_key: `unresolved:inbound_sms_log:${id}`, counterparty_user_id: null,
            counterparty_phone: null, metadata: { historical: true, sendDisabled: true,
              archiveReason: "receipt_owner_conflict" }, event_count: 1 });
          tables.sms_projection_turns.push({ owner_manager_user_id: B, conversation_id: "retained-conversation",
            source_namespace: "retained:inbound_sms_log", source_event_id: id, provider_sid: SID,
            direction: "inbound", body: BODY, occurred_at: tables.inbound_sms_log[0].created_at,
            from_phone: FROM, to_phone: TO, source_ref: { table: "inbound_sms_log", id, historical: true,
              archiveReason: "receipt_owner_conflict", fingerprint: "a".repeat(64),
              mirror: { table: "manager_sms_messages", id: tables.manager_sms_messages[0].id,
                occurredAt: tables.manager_sms_messages[0].created_at } } });
        }
        return { data: { inserted: !prior, historicalSourcePreserved: true,
          historicalSourceMirrorAccounted: true }, error: null };
      }
      if (name === "resolve_sms_completed_receipt_original") {
        originalCalls += 1;
        if (missingOriginal) return { data: { ok: false, reason: "original_missing" }, error: null };
        if (badPayload) return { data: { ok: false, reason: "payload_invalid" }, error: null };
        if (failLog && originalCalls >= 2) return { data: { ok: false, reason: "owner_mismatch" }, error: null };
        const owner = payloadOnly || pendingLog ? A : B;
        if (args.p_sid !== SID || args.p_expected_owner !== owner) {
          return { data: { ok: false, reason: "owner_mismatch" }, error: null };
        }
        return { data: { ok: true, sid: SID, receiptOwner: A, owner, status: pendingLog ? "retryable" : "completed",
          body: BODY, fromPhone: FROM, toPhone: TO, occurredAt: tables.sms_inbound_receipts[0].first_received_at, role: payloadOnly ? "unknown" : pendingLog ? "resident" : "prospect", userId: null,
          conversationKey: pendingLog ? "retained-opaque-key" : null, workLineId: payloadOnly ? null : "line-1", ingress: !payloadOnly && !pendingLog,
          source: payloadOnly ? "receipt_payload" : "durable_log" }, error: null };
      }
      if (name === "project_sms_conversation_event") {
        const event = args.p_event as Row;
        const prior = tables.sms_projection_turns.find((row) => row.provider_sid === SID);
        if (prior) return { data: { inserted: false }, error: null };
        tables.sms_projection_conversations.push({ id: "conversation-1", counterparty_role: event.counterpartyRole,
          work_line_id: event.workLineId, identity_kind: event.identityKind, identity_key: event.identityKey,
          counterparty_user_id: event.counterpartyUserId, counterparty_phone: event.counterpartyPhone,
          metadata: {}, event_count: 1 });
        tables.sms_projection_turns.push({ owner_manager_user_id: event.ownerManagerUserId,
          conversation_id: "conversation-1", source_namespace: event.sourceNamespace,
          source_event_id: event.sourceEventId, provider_sid: SID, direction: event.direction,
          body: event.body, occurred_at: event.occurredAt, from_phone: event.fromPhone,
          to_phone: event.toPhone, source_ref: event.sourceRef });
        return { data: { inserted: true }, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "sms-backfill-correction-")); dirs.push(dir);
  return { db, tables, cursorFile: join(dir, "cursor.json"), calls: () => originalCalls,
    retainedCalls: () => retainedImports, retainedLookups: () => retainedLookups };
}

describe("completed original backfill across all durable feeds", () => {
  it("preserves one retained source and accounts for its differently timed mirror across two passes", async () => {
    const { db, tables, cursorFile, calls, retainedCalls, retainedLookups } = fixture({ retained: true });
    const opts = { apply: true, cursorFile, batchSize: 100, maxPages: 10 };
    const first = await runBackfill(db, opts);
    const second = await runBackfill(db, opts);
    expect(first).toMatchObject({ cleanPasses: 1, readyForApply: true });
    expect(second).toMatchObject({ complete: true, cleanPasses: 2 });
    expect(first.sources.find((s: Row) => s.source === "inbound_sms_log")?.counts.historicalSourcePreserved).toBe(1);
    expect(first.sources.find((s: Row) => s.source === "manager_sms_messages")?.counts.historicalSourceMirrorAccounted).toBe(1);
    expect(tables.sms_projection_turns).toHaveLength(1);
    expect(tables.sms_projection_turns[0]).toMatchObject({ owner_manager_user_id: B,
      occurred_at: "2026-09-02T20:20:41.259580Z", source_namespace: "retained:inbound_sms_log" });
    expect(tables.sms_projection_conversations[0]).toMatchObject({ identity_kind: "unresolved",
      counterparty_user_id: null, metadata: { historical: true, sendDisabled: true,
        archiveReason: "receipt_owner_conflict" } });
    expect(calls()).toBe(0);
    expect(retainedCalls()).toBe(4);
    expect(retainedLookups()).toBe(4);
  });

  it("fails closed when retained evidence query fails", async () => {
    const { db, cursorFile } = fixture({ retained: true, retainedLookupError: true });
    await expect(runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 }))
      .rejects.toThrow("retained_source_lookup_failed");
  });
  it("accounts for a co-manager holder under the canonical owner through two clean passes", async () => {
    const { db, tables, cursorFile, calls, retainedLookups } = fixture();
    const opts = { apply: true, cursorFile, batchSize: 100, maxPages: 10 };
    const first = await runBackfill(db, opts);
    expect(first).toMatchObject({ complete: false, readyForApply: true, cleanPasses: 1 });
    expect(first.sources.slice(0, 3).map((s: Row) => s.counts.integrityMismatch)).toEqual([0, 0, 0]);
    expect(tables.sms_projection_turns).toHaveLength(1);
    expect(tables.sms_projection_turns[0]).toMatchObject({ owner_manager_user_id: B, body: BODY, occurred_at: AT });
    expect(tables.sms_projection_cutover[0].ready).toBe(false);
    const second = await runBackfill(db, opts);
    expect(second).toMatchObject({ complete: true, readyForApply: true, cleanPasses: 2, readinessUpdated: true });
    expect(tables.sms_projection_turns).toHaveLength(1);
    expect(tables.sms_projection_cutover[0].ready).toBe(true);
    expect(calls()).toBe(4);
    expect(retainedLookups()).toBe(0);
    expect(first.sources.find((source: Row) => source.source === "sms_inbound_receipts")?.counts.scanned).toBe(0);
  });

  it("ignores a source-free completed null-payload receipt in both clean passes", async () => {
    const { db, tables, cursorFile, calls } = fixture();
    tables.prospect_sms_ingress = [];
    tables.prospect_sms_bursts = [];
    tables.inbound_sms_log = [];
    const opts = { apply: true, cursorFile, batchSize: 100, maxPages: 10 };
    const first = await runBackfill(db, opts);
    const second = await runBackfill(db, opts);
    expect(first).toMatchObject({ readyForApply: true, cleanPasses: 1 });
    expect(second).toMatchObject({ complete: true, cleanPasses: 2 });
    expect(first.sources.find((source: Row) => source.source === "sms_inbound_receipts")?.counts.scanned).toBe(0);
    expect(tables.sms_projection_turns).toHaveLength(0);
    expect(calls()).toBe(0);
  });

  it("counts a retained retryable original through its log in two clean passes without changing the receipt", async () => {
    const { db, tables, cursorFile } = fixture({ pendingLog: true });
    const opts = { apply: true, cursorFile, batchSize: 100, maxPages: 10 };
    const first = await runBackfill(db, opts);
    const second = await runBackfill(db, opts);
    expect(first).toMatchObject({ cleanPasses: 1, readyForApply: true });
    expect(second).toMatchObject({ complete: true, cleanPasses: 2 });
    expect(tables.sms_projection_turns).toHaveLength(1);
    expect(tables.sms_projection_turns[0]).toMatchObject({ body: BODY, occurred_at: AT });
    expect(tables.sms_inbound_receipts[0]).toMatchObject({ status: "retryable", inbound_payload: null });
  });

  it("does not use a released line when the original is one microsecond after its epoch", async () => {
    const { db, tables, cursorFile } = fixture();
    tables.manager_sms_numbers[0].released_at = "2026-09-25T12:00:00.000000Z";
    tables.sms_inbound_receipts[0].first_received_at = "2026-09-25T12:00:00.000001Z";
    const isolated = await import(`${new URL("../../scripts/backfill-sms-projection.mjs", import.meta.url).href}?epoch-boundary`);
    await expect(isolated.runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 }))
      .rejects.toThrow("prospect_ingress_work_line_conflict");
    expect(tables.sms_projection_turns).toHaveLength(0);
  });

  it("still validates a present receipt payload as its own source", async () => {
    const { db, tables, cursorFile, calls } = fixture({ payloadOnly: true });
    const opts = { apply: true, cursorFile, batchSize: 100, maxPages: 10 };
    const first = await runBackfill(db, opts);
    const second = await runBackfill(db, opts);
    expect(first.sources.find((source: Row) => source.source === "sms_inbound_receipts")?.counts.scanned).toBe(1);
    expect(second).toMatchObject({ complete: true, cleanPasses: 2 });
    expect(tables.sms_projection_turns).toHaveLength(1);
    expect(tables.sms_projection_turns[0]).toMatchObject({ owner_manager_user_id: A, body: BODY, occurred_at: AT });
    expect(calls()).toBe(2);
  });

  it("keeps a malformed present payload unresolved without advancing its receipt cursor", async () => {
    const { db, tables, cursorFile } = fixture({ payloadOnly: true, badPayload: true });
    await expect(runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 }))
      .rejects.toThrow("inbound_original_payload_invalid");
    expect(existsSync(cursorFile)).toBe(false);
    expect(tables.sms_projection_turns).toHaveLength(0);
    expect(tables.sms_projection_cutover[0].ready).toBe(false);
  });

  it("blocks a receipt-backed manager log without the shared original proof", async () => {
    const { db, tables, cursorFile } = fixture({ missingOriginal: true });
    tables.prospect_sms_ingress = [];
    tables.prospect_sms_bursts = [];
    tables.inbound_sms_log = [];
    tables.manager_sms_messages = [{ id: "44444444-4444-4444-8444-444444444444", manager_user_id: A,
      resident_user_id: null, resident_phone: FROM, direction: "inbound", body: BODY,
      from_phone: FROM, to_phone: TO, message_sid: SID, source: "work_number",
      created_at: AT, counterparty_role: "unknown", conversation_key: null }];
    await expect(runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 }))
      .rejects.toThrow("inbound_original_original_missing");
    expect(existsSync(cursorFile)).toBe(false);
    expect(tables.sms_projection_turns).toHaveLength(0);
    expect(tables.sms_projection_cutover[0].ready).toBe(false);
  });

  it("blocks an ingress-referenced completed original with no durable transcript", async () => {
    const { db, tables, cursorFile } = fixture({ missingOriginal: true });
    tables.inbound_sms_log = [];
    await expect(runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 }))
      .rejects.toThrow("inbound_original_original_missing");
    expect(tables.sms_projection_turns).toHaveLength(0);
    expect(tables.sms_projection_cutover[0].ready).toBe(false);
  });

  it("does not advance the failed log cursor or readiness", async () => {
    const { db, tables, cursorFile } = fixture({ failLog: true });
    await expect(runBackfill(db, { apply: true, cursorFile, batchSize: 100, maxPages: 10 })).rejects.toThrow("inbound_original_owner_mismatch");
    const state = JSON.parse(readFileSync(cursorFile, "utf8"));
    expect(state.cursors.inbound_sms_log).toBeUndefined();
    expect(state.cleanPasses).toBe(0);
    expect(tables.sms_projection_cutover[0].ready).toBe(false);
  });

  it("limits concurrent RPC work independently of a large page", async () => {
    let active = 0; let peak = 0;
    const output = await mapBounded(Array.from({ length: 500 }, (_, i) => i), 8, async (item: number) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return item * 2;
    });
    expect(peak).toBe(8);
    expect(output).toHaveLength(500);
    expect(output[499]).toBe(998);
  });
});
