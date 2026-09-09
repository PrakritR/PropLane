import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";
import { updateSmsNoticeMailboxState, smsNoticeMembers } from "@/lib/sms-inbox-state.server";
import { inboxThreadMessages, type PersistedInboxThread } from "@/lib/portal-inbox-storage";

type Row = { id: string; owner_user_id: string; scope: string; thread_type: string; row_data: Record<string, unknown>; updated_at: string };
function memoryDb() {
  const rows = new Map<string, Row>();
  const db = { from() {
    const filters: [string, unknown][] = [];
    let operation = "read";
    let value: Partial<Row> = {};
    let single = false;
    const q = {
      select: () => q, order: () => q, range: () => q,
      eq(key: string, expected: unknown) { filters.push([key, expected]); return q; },
      upsert(row: Row) { operation = "insert"; value = row; return q; },
      update(row: Partial<Row>) { operation = "update"; value = row; return q; },
      single() { single = true; return q; },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve().then(() => {
          if (operation === "insert") {
            if (rows.has(value.id!)) return { data: [], error: null };
            rows.set(value.id!, structuredClone(value as Row));
            return { data: [{ id: value.id }], error: null };
          }
          const found = [...rows.values()].filter((r) => filters.every(([k, v]) => r[k as keyof Row] === v));
          if (operation === "update") for (const row of found) rows.set(row.id, structuredClone({ ...row, ...value }));
          return { data: structuredClone(single ? found[0] : found), error: null };
        }).then(resolve, reject);
      },
    };
    return q;
  } } as unknown as SupabaseClient;
  return { db, rows };
}
const args = { managerUserId: "manager-a", idPrefix: "claw_lease", threadType: "claw_leasing_sms", from: "+12065550100", subject: "Text", preview: "Text", body: "First", messageId: "sid-first" };

describe("SMS inbox durable append", () => {
  it("keeps concurrent messages and normalizes phone formatting onto one stored conversation", async () => {
    const { db, rows } = memoryDb();
    await Promise.all([
      upsertManagerInboxNotice(db, args),
      upsertManagerInboxNotice(db, { ...args, from: "(206) 555-0100", body: "Second", messageId: "sid-second" }),
      upsertManagerInboxNotice(db, { ...args, body: "Third", messageId: "sid-third" }),
    ]);
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0]!;
    expect(inboxThreadMessages(row.row_data as unknown as PersistedInboxThread).map((m) => m.body)).toEqual(["First", "Second", "Third"]);
    await upsertManagerInboxNotice(db, { ...args, body: "Second", messageId: "sid-second" });
    expect((rows.get(row.id)!.row_data.messages as unknown[])).toHaveLength(2);
    expect(row.row_data.rootAt).toBeTruthy();
  });

  it("preserves arrivals when an older browser snapshot marks the conversation read", async () => {
    const { db, rows } = memoryDb();
    await upsertManagerInboxNotice(db, args);
    const stale = structuredClone([...rows.values()][0]!);
    await upsertManagerInboxNotice(db, { ...args, body: "New arrival", messageId: "sid-new" });
    await updateSmsNoticeMailboxState(db, stale, { ...stale.row_data, unread: false, body: "Stale overwrite", messages: [] });
    const current = rows.get(stale.id)!;
    expect(current.row_data.body).toBe("First");
    expect((current.row_data.messages as { body: string }[])[0]?.body).toBe("New arrival");
    expect(current.row_data.unread).toBe(false);
  });

  /**
   * One inbound text can be mirrored by more than one producer: the leasing bot
   * files the raw text, the resident path files the manager brief. They share
   * the Twilio SID, so an un-namespaced delivery id makes the second mirror look
   * like a retry of the first and it is dropped. Namespacing keeps retry folding
   * per producer without losing a turn.
   */
  it("folds a producer's retry but keeps another producer's mirror of the same inbound", async () => {
    const { db, rows } = memoryDb();
    await upsertManagerInboxNotice(db, { ...args, messageId: "leasing_SM1", body: "Wants a tour" });
    await upsertManagerInboxNotice(db, { ...args, messageId: "resident_SM1", body: "Brief for the manager" });
    await upsertManagerInboxNotice(db, { ...args, messageId: "leasing_SM1", body: "Wants a tour" });
    const row = [...rows.values()][0]!;
    expect(inboxThreadMessages(row.row_data as unknown as PersistedInboxThread).map((m) => m.body)).toEqual([
      "Wants a tour",
      "Brief for the manager",
    ]);
  });

  it("namespaces the delivery id at every producer", () => {
    for (const [file, prefix] of [
      ["src/lib/sms-relay.server.ts", "relay_"],
      ["src/lib/claw-resident-messaging.server.ts", "resident_"],
      ["src/lib/claw-leasing-bot.server.ts", "leasing_"],
    ] as const) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`\`${prefix}$`);
      expect(source).not.toMatch(/messageId: args\.message(Sid|Id) \?\? undefined/);
    }
  });

  it("archives all historical phone members but never another owner's rows", async () => {
    const { db, rows } = memoryDb();
    await upsertManagerInboxNotice(db, args);
    await upsertManagerInboxNotice(db, { ...args, managerUserId: "manager-b" });
    const target = [...rows.values()].find((r) => r.owner_user_id === "manager-a")!;
    const legacy = { ...structuredClone(target), id: "claw_lease_legacy", row_data: { ...target.row_data, id: "claw_lease_legacy" } };
    rows.set(legacy.id, legacy);
    expect(await smsNoticeMembers(db, target)).toHaveLength(2);
    await updateSmsNoticeMailboxState(db, target, { folder: "trash", unread: false });
    expect(rows.get(legacy.id)!.row_data.folder).toBe("trash");
    expect([...rows.values()].find((r) => r.owner_user_id === "manager-b")!.row_data.folder).toBe("inbox");
  });
});
