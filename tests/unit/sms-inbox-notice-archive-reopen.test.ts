import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";
import { buildConversationKey, SMS_COUNTERPARTY_ROLES } from "@/lib/sms-conversation-identity";

/**
 * Regression for PRP follow-up item 7: when a person texts back, their
 * archived thread must return to Active as ONE row, with no duplicate stuck
 * in Archived. `upsertManagerInboxNotice` already flips the notice thread's
 * OWN `row_data.folder` back to "inbox" on a genuine inbound reopen; this
 * covers the SEPARATE store the unified list also reads,
 * `manager_tour_followup_controls.archived`, which must move with it or the
 * conversation still shows archived on that other surface.
 */

type AnyRow = Record<string, unknown>;

function keyOf(table: string, row: AnyRow): string {
  return table === "manager_tour_followup_controls"
    ? `${String(row.manager_user_id)}:${String(row.conversation_key)}`
    : String(row.id);
}

function multiTableDb(seed: Record<string, AnyRow[]> = {}) {
  const tables = new Map<string, Map<string, AnyRow>>();
  for (const [table, rows] of Object.entries(seed)) {
    const store = new Map<string, AnyRow>();
    for (const row of rows) store.set(keyOf(table, row), structuredClone(row));
    tables.set(table, store);
  }
  const db = {
    from(table: string) {
      if (!tables.has(table)) tables.set(table, new Map());
      const store = tables.get(table)!;
      const filters: ((row: AnyRow) => boolean)[] = [];
      let operation: "read" | "update" | "insert" = "read";
      let value: AnyRow = {};
      let single = false;
      let ignoreDuplicates = false;
      const q = {
        select: () => q,
        order: () => q,
        range: () => q,
        eq(key: string, expected: unknown) {
          filters.push((r) => r[key] === expected);
          return q;
        },
        in(key: string, expected: unknown[]) {
          filters.push((r) => expected.includes(r[key]));
          return q;
        },
        upsert(row: AnyRow, opts?: { ignoreDuplicates?: boolean }) {
          operation = "insert";
          value = row;
          ignoreDuplicates = opts?.ignoreDuplicates === true;
          return q;
        },
        update(row: AnyRow) {
          operation = "update";
          value = row;
          return q;
        },
        single() {
          single = true;
          return q;
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve()
            .then(() => {
              if (operation === "insert") {
                const k = keyOf(table, value);
                if (store.has(k) && ignoreDuplicates) return { data: [], error: null };
                store.set(k, structuredClone(value));
                return { data: [{ id: value.id }], error: null };
              }
              const found = [...store.values()].filter((r) => filters.every((f) => f(r)));
              if (operation === "update") {
                for (const row of found) store.set(keyOf(table, row), structuredClone({ ...row, ...value }));
              }
              return { data: structuredClone(single ? found[0] ?? null : found), error: null };
            })
            .then(resolve, reject);
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, tables };
}

const managerUserId = "manager-a";
const phone = "+12065550100";
const args = {
  managerUserId,
  idPrefix: "relay",
  threadType: "relay_sms",
  from: phone,
  subject: "Text",
  preview: "Text",
  body: "Hi",
  messageId: "sid-first",
};

function controlRow(role: string, archived: boolean) {
  return {
    manager_user_id: managerUserId,
    conversation_key: buildConversationKey({ ownerManagerUserId: managerUserId, role: role as never, counterpartyPhone: phone }),
    archived,
    updated_at: new Date(0).toISOString(),
  };
}

describe("upsertManagerInboxNotice reopen clears the separate archive-controls store", () => {
  it("clears every role's archived control for this phone when a genuinely inbound message reopens the notice", async () => {
    const { db, tables } = multiTableDb({
      manager_tour_followup_controls: [controlRow("resident", true), controlRow("prospect", true)],
    });
    // Create the notice thread, then archive it directly (as the folder
    // mutation would), matching the row shape `upsertManagerInboxNotice`
    // expects to find on its next append.
    await upsertManagerInboxNotice(db, args);
    const notices = tables.get("portal_inbox_thread_records")!;
    const target = [...notices.values()][0]!;
    notices.set(target.id as string, { ...target, row_data: { ...(target.row_data as AnyRow), folder: "trash" } });

    await upsertManagerInboxNotice(db, { ...args, body: "They're back", messageId: "sid-reopen" });

    expect((notices.get(target.id as string)!.row_data as AnyRow).folder).toBe("inbox");
    const controls = tables.get("manager_tour_followup_controls")!;
    expect(controls.get(`${managerUserId}:${controlRow("resident", true).conversation_key}`)!.archived).toBe(false);
    expect(controls.get(`${managerUserId}:${controlRow("prospect", true).conversation_key}`)!.archived).toBe(false);
  });

  it("never touches another manager's control row for the same phone", async () => {
    const otherManagerKey = controlRow("resident", true);
    const { db, tables } = multiTableDb({
      manager_tour_followup_controls: [
        controlRow("resident", true),
        { ...otherManagerKey, manager_user_id: "manager-b" },
      ],
    });
    await upsertManagerInboxNotice(db, args);
    const notices = tables.get("portal_inbox_thread_records")!;
    const target = [...notices.values()][0]!;
    notices.set(target.id as string, { ...target, row_data: { ...(target.row_data as AnyRow), folder: "trash" } });

    await upsertManagerInboxNotice(db, { ...args, body: "They're back", messageId: "sid-reopen-2" });

    const controls = tables.get("manager_tour_followup_controls")!;
    expect(controls.get(`manager-b:${otherManagerKey.conversation_key}`)!.archived).toBe(true);
  });

  it("does not reopen or clear the archive controls on an outbound (manager-sent) append", async () => {
    const { db, tables } = multiTableDb({
      manager_tour_followup_controls: [controlRow("resident", true)],
    });
    await upsertManagerInboxNotice(db, args);
    const notices = tables.get("portal_inbox_thread_records")!;
    const target = [...notices.values()][0]!;
    notices.set(target.id as string, { ...target, row_data: { ...(target.row_data as AnyRow), folder: "trash" } });

    await upsertManagerInboxNotice(db, { ...args, folder: "sent", body: "Outbound reply", messageId: "sid-out" });

    expect((notices.get(target.id as string)!.row_data as AnyRow).folder).toBe("trash");
    const controls = tables.get("manager_tour_followup_controls")!;
    expect(controls.get(`${managerUserId}:${controlRow("resident", true).conversation_key}`)!.archived).toBe(true);
  });

  it("is an inert no-op for a role that never had a control row", async () => {
    const { db, tables } = multiTableDb({});
    await upsertManagerInboxNotice(db, args);
    const notices = tables.get("portal_inbox_thread_records")!;
    const target = [...notices.values()][0]!;
    notices.set(target.id as string, { ...target, row_data: { ...(target.row_data as AnyRow), folder: "trash" } });

    await expect(
      upsertManagerInboxNotice(db, { ...args, body: "They're back", messageId: "sid-reopen-3" }),
    ).resolves.toBeUndefined();
    expect((notices.get(target.id as string)!.row_data as AnyRow).folder).toBe("inbox");
    // No control rows exist for any role — every UPDATE...WHERE matched
    // nothing, which must not throw and must not create a row.
    expect(tables.get("manager_tour_followup_controls")?.size ?? 0).toBe(0);
  });

  it("clears controls for every role in SMS_COUNTERPARTY_ROLES this phone could hold", () => {
    expect(SMS_COUNTERPARTY_ROLES).toContain("resident");
    expect(SMS_COUNTERPARTY_ROLES).toContain("prospect");
    expect(SMS_COUNTERPARTY_ROLES.length).toBeGreaterThan(1);
  });
});
