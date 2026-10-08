import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: vi.fn(async () => ({ id: "ws-default", isDefault: true })),
}));

import {
  appendSmsTurnToManagerAssistantThread,
  mirrorManagerOwnOutboxToAssistantThread,
  outboxPurposeMirroredByNotice,
} from "@/lib/sms/manager-assistant-thread-mirror.server";

type Row = Record<string, unknown>;

/** Tiny in-memory PostgREST double: eq filters, select/update/upsert, maybeSingle. */
function fakeDb(seedRows: Record<string, Row[]>, failThreadWrites = false) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seedRows));
  const from = (name: string) => {
    tables[name] ??= [];
    const filters: [string, unknown][] = [];
    let mode: "select" | "update" = "select";
    let patch: Row = {};
    const matches = () => tables[name]!.filter((r) => filters.every(([k, v]) => r[k] === v));
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (k: string, v: unknown) => (filters.push([k, v]), builder),
      limit: () => builder,
      update: (p: Row) => ((mode = "update"), (patch = p), builder),
      upsert: (p: Row) => {
        const existing = tables[name]!.find((r) => r.id === p.id);
        if (existing) Object.assign(existing, p);
        else tables[name]!.push({ ...p });
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => Promise.resolve({ data: matches()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (mode === "update" && failThreadWrites && name === "portal_inbox_thread_records") {
          resolve({ data: null, error: { message: "boom" } });
          return;
        }
        const rows = matches();
        if (mode === "update") rows.forEach((r) => Object.assign(r, patch));
        resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
      },
    };
    return builder;
  };
  return { db: { from } as never, tables };
}

const OWNER = "mgr-1";
const THREAD = `agent_notice_${OWNER}`;

function seed() {
  return {
    profiles: [{ id: OWNER, phone: "+15105791976" }],
    manager_sms_numbers: [],
    portal_workspaces: [],
    portal_inbox_thread_records: [
      {
        id: THREAD,
        owner_user_id: OWNER,
        updated_at: "2026-10-08T00:00:00.000Z",
        row_data: { id: THREAD, unread: false, folder: "inbox", from: "PropLane Assistant", messages: [] },
      },
    ],
  };
}

const forwardRow = (over: Record<string, unknown> = {}) => ({
  id: "outbox-1",
  manager_user_id: OWNER,
  actor_user_id: OWNER,
  recipient_phone: "+15105791976",
  body: "Texter ····8345: Hey\n\nReply in PropLane to answer them.",
  purpose: "manager_inbound_forward",
  counterparty_role: "manager",
  ...over,
});

const threadRow = (tables: Record<string, Row[]>) => tables.portal_inbox_thread_records![0]!.row_data as Row;
const messagesOf = (tables: Record<string, Row[]>) => threadRow(tables).messages as Row[];

describe("manager SMS to the PropLane Assistant thread", () => {
  it("a forward produces exactly one SMS-marked Assistant message and is idempotent on retry", async () => {
    const { db, tables } = fakeDb(seed());
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow(), "+15550001111")).toBe("mirrored");
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow(), "+15550001111")).toBe("mirrored");
    const msgs = messagesOf(tables);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      id: "sms_out_outbox-1",
      from: "PropLane Assistant",
      channel: "sms",
      outbound: false,
      body: "Texter ····8345: Hey\n\nReply in PropLane to answer them.",
    });
    expect(threadRow(tables).unread).toBe(true);
  });

  it("writes nothing for a send that is not to the manager's own phone, or not a manager row", async () => {
    const { db, tables } = fakeDb(seed());
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow({ recipient_phone: "+15103098345" }), null)).toBe("skipped");
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow({ counterparty_role: "prospect" }), null)).toBe("skipped");
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow({ purpose: "manager_agent_notification_leasing" }), null)).toBe("skipped");
    expect(outboxPurposeMirroredByNotice("manager_agent_notification_leasing")).toBe(true);
    expect(messagesOf(tables)).toHaveLength(0);
  });

  it("the manager's inbound text and the agent reply land in the same single thread", async () => {
    const { db, tables } = fakeDb(seed());
    const inbound = await appendSmsTurnToManagerAssistantThread(db, {
      ownerUserId: OWNER, messageId: "sms_in_SM1", author: "manager", body: "how many tours today?",
    });
    expect(inbound).toMatchObject({ ok: true, threadId: THREAD, appended: true });
    await mirrorManagerOwnOutboxToAssistantThread(
      db,
      forwardRow({ id: "outbox-2", purpose: "manager_conversation", body: "You have 3 tours today." }),
      null,
    );
    // webhook retry of the same inbound
    await appendSmsTurnToManagerAssistantThread(db, {
      ownerUserId: OWNER, messageId: "sms_in_SM1", author: "manager", body: "how many tours today?",
    });
    expect(messagesOf(tables).map((m) => [m.from, m.channel, m.outbound])).toEqual([
      ["You", "sms", true],
      ["PropLane Assistant", "sms", false],
    ]);
    expect(tables.portal_inbox_thread_records).toHaveLength(1);
  });

  it("never creates a second assistant thread and keeps the manager's own text read", async () => {
    const { db, tables } = fakeDb(seed());
    await appendSmsTurnToManagerAssistantThread(db, {
      ownerUserId: OWNER, messageId: "sms_in_SM2", author: "manager", body: "hi",
    });
    expect(tables.portal_inbox_thread_records!.map((r) => r.id)).toEqual([THREAD]);
    expect(threadRow(tables).unread).toBe(false);
  });

  it("fails, so the repair queue retries, when the thread cannot be written", async () => {
    const { db } = fakeDb(seed(), true);
    expect(await mirrorManagerOwnOutboxToAssistantThread(db, forwardRow(), null)).toBe("failed");
  });
});
