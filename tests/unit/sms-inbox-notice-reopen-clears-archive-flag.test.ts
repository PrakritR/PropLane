import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";

/**
 * Regression for the captain resurrection sweep, item 2 follow-up: an
 * inbound text correctly reopens the notice row (`row_data.folder` back to
 * "inbox"), but `manager_tour_followup_controls.archived` stayed `true` —
 * the SMS-conversation view (fetchManagerSmsConversations /
 * mirrorManagerSmsArchivedFromServer) kept the conversation in Archived
 * while its own notice thread had already returned to Active. Both stores
 * must move together on a genuine reopen; an outbound append must leave
 * both alone.
 */

type ThreadRow = { id: string; owner_user_id: string; scope: string; thread_type: string; row_data: Record<string, unknown>; updated_at: string };
type ControlRow = { manager_user_id: string; conversation_key: string; archived: boolean; updated_at: string };

function makeDb(threadSeed: ThreadRow[], controlSeed: ControlRow[]) {
  const threads = new Map<string, ThreadRow>(threadSeed.map((r) => [r.id, structuredClone(r)]));
  const controls = new Map<string, ControlRow>(
    controlSeed.map((r) => [`${r.manager_user_id}\0${r.conversation_key}`, structuredClone(r)]),
  );

  function threadTable() {
    const filters: [string, unknown][] = [];
    let operation: "read" | "insert" | "update" = "read";
    let value: Partial<ThreadRow> = {};
    let single = false;
    const q = {
      select: () => q,
      eq(key: string, expected: unknown) {
        filters.push([key, expected]);
        return q;
      },
      upsert(row: ThreadRow) {
        operation = "insert";
        value = row;
        return q;
      },
      update(row: Partial<ThreadRow>) {
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
              if (threads.has(value.id!)) return { data: [], error: null };
              threads.set(value.id!, structuredClone(value as ThreadRow));
              return { data: [{ id: value.id }], error: null };
            }
            const found = [...threads.values()].filter((r) =>
              filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v),
            );
            if (operation === "update") {
              for (const row of found) threads.set(row.id, structuredClone({ ...row, ...value }));
            }
            return { data: structuredClone(single ? found[0] : found), error: null };
          })
          .then(resolve, reject);
      },
    };
    return q;
  }

  function controlsTable() {
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    let updateValue: Partial<ControlRow> | null = null;
    const match = (r: ControlRow) =>
      eqFilters.every(([c, v]) => (r as Record<string, unknown>)[c] === v) &&
      inFilters.every(([c, vals]) => vals.includes((r as Record<string, unknown>)[c]));
    const q = {
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return q;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push([col, vals]);
        return q;
      },
      update(val: Partial<ControlRow>) {
        updateValue = val;
        return q;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve()
          .then(() => {
            if (updateValue) {
              for (const row of controls.values()) {
                if (match(row)) Object.assign(row, updateValue);
              }
            }
            return { data: null, error: null };
          })
          .then(resolve, reject);
      },
    };
    return q;
  }

  const db = {
    from(table: string) {
      return table === "manager_tour_followup_controls" ? controlsTable() : threadTable();
    },
  } as unknown as SupabaseClient;
  return { db, threads, controls };
}

const MANAGER = "manager-a";
const PHONE = "+12065550100";
const args = {
  managerUserId: MANAGER,
  idPrefix: "sms_relay_thread",
  threadType: "sms_relay",
  from: "Resident",
  subject: "Text relay",
  preview: "Existing",
  body: "Existing",
  counterpartyPhone: PHONE,
};

function seedArchivedThread(): ThreadRow {
  return {
    id: `sms_notice_${createHash("sha256").update(`${MANAGER}:${PHONE}`).digest("hex")}`,
    owner_user_id: MANAGER,
    scope: "axis_portal_inbox_manager_v1",
    thread_type: "sms_relay",
    row_data: {
      folder: "trash",
      previousFolder: "inbox",
      from: "Resident",
      subject: "Text relay",
      body: "Existing",
      preview: "Existing",
      rootAt: "Sep 1, 9:00 AM",
      time: "Sep 1, 9:00 AM",
      unread: false,
      rootMessageId: "sid-root",
      smsNoticePhone: PHONE,
      messages: [],
    },
    updated_at: "2026-09-01T09:00:00.000Z",
  };
}

function controlRowFor(role: "resident" | "applicant" | "prospect" | "vendor" | "manager" | "admin" | "unknown"): ControlRow {
  return {
    manager_user_id: MANAGER,
    conversation_key: buildConversationKey({ ownerManagerUserId: MANAGER, role, counterpartyPhone: PHONE }),
    archived: true,
    updated_at: "2026-09-01T09:00:00.000Z",
  };
}

describe("upsertManagerInboxNotice reopening clears manager_tour_followup_controls", () => {
  it("clears the controls archived flag when an inbound text reopens the notice", async () => {
    const controlRow = controlRowFor("resident");
    const { db, threads, controls } = makeDb([seedArchivedThread()], [controlRow]);

    await upsertManagerInboxNotice(db, { ...args, body: "New inbound text", messageId: "sid-inbound-1" });

    const thread = [...threads.values()][0]!;
    expect(thread.row_data.folder).toBe("inbox");
    const control = controls.get(`${MANAGER}\0${controlRow.conversation_key}`)!;
    expect(control.archived).toBe(false);
  });

  it("clears every role variant of the phone's conversation key, never another manager's row", async () => {
    const residentControl = controlRowFor("resident");
    const applicantControl = controlRowFor("applicant");
    const otherManagerControl: ControlRow = {
      manager_user_id: "manager-b",
      conversation_key: buildConversationKey({ ownerManagerUserId: "manager-b", role: "resident", counterpartyPhone: PHONE }),
      archived: true,
      updated_at: "2026-09-01T09:00:00.000Z",
    };
    const { db, controls } = makeDb([seedArchivedThread()], [residentControl, applicantControl, otherManagerControl]);

    await upsertManagerInboxNotice(db, { ...args, body: "New inbound text", messageId: "sid-inbound-2" });

    expect(controls.get(`${MANAGER}\0${residentControl.conversation_key}`)!.archived).toBe(false);
    expect(controls.get(`${MANAGER}\0${applicantControl.conversation_key}`)!.archived).toBe(false);
    // Another manager's control row for the SAME phone must never be touched.
    expect(controls.get(`manager-b\0${otherManagerControl.conversation_key}`)!.archived).toBe(true);
  });

  it("leaves the controls archived flag alone on an outbound append", async () => {
    const controlRow = controlRowFor("resident");
    const { db, threads, controls } = makeDb([seedArchivedThread()], [controlRow]);

    await upsertManagerInboxNotice(db, { ...args, folder: "sent", body: "Manager's own outbound relay text", messageId: "sid-outbound-1" });

    const thread = [...threads.values()][0]!;
    expect(thread.row_data.folder).toBe("trash");
    expect(controls.get(`${MANAGER}\0${controlRow.conversation_key}`)!.archived).toBe(true);
  });

  it("does not touch the controls table when the notice was already active (no genuine reopen)", async () => {
    const activeThread = { ...seedArchivedThread() };
    activeThread.row_data = { ...activeThread.row_data, folder: "inbox" };
    const controlRow = controlRowFor("resident");
    const { db, controls } = makeDb([activeThread], [controlRow]);

    await upsertManagerInboxNotice(db, { ...args, body: "Another inbound text", messageId: "sid-inbound-3" });

    // The control row is stale here on purpose (archived:true while the
    // thread is already active) to prove this path leaves it untouched
    // rather than clearing every phone-matched control row unconditionally.
    expect(controls.get(`${MANAGER}\0${controlRow.conversation_key}`)!.archived).toBe(true);
  });
});
