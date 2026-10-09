import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { noticeRpcMemory } from "./sms-notice-rpc-memory";
import {
  recordAutoReplyOnSmsNotice,
  smsNoticeThreadId,
  upsertManagerInboxNotice,
} from "@/lib/sms-inbox-notice.server";
import {
  inboxThreadManagerReplyPending,
  inboxThreadMessages,
  isServerAgentAnsweredSmsThread,
  lastInboundChannelOf,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

type Row = { id: string; owner_user_id: string; scope: string; thread_type: string; row_data: Record<string, unknown>; updated_at: string };

/** A database with the notice RPC and the single-row read `recordAutoReplyOnSmsNotice` makes. */
function memoryDb() {
  const rows = new Map<string, Row>();
  const db = {
    rpc: noticeRpcMemory(rows),
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      const q = {
        select: () => q,
        eq(key: string, expected: unknown) {
          filters.push((row) => row[key as keyof Row] === expected);
          return q;
        },
        maybeSingle: async () => ({
          data: [...rows.values()].find((row) => filters.every((f) => f(row))) ?? null,
          error: null,
        }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { db, rows };
}

const PHONE = "+12065550100";
const base = {
  managerUserId: "manager-a",
  idPrefix: "claw_lease",
  threadType: "claw_leasing_sms",
  from: PHONE,
  subject: "Text",
  preview: "Is the room open?",
  body: "Is the room open?",
  messageId: "sid-1",
};

function thread(row: Row): PersistedInboxThread {
  return row.row_data as unknown as PersistedInboxThread;
}

describe("inbound SMS notices carry the sms channel stamp", () => {
  it("stamps the root turn and every appended turn", async () => {
    const { db, rows } = memoryDb();
    await upsertManagerInboxNotice(db, base);
    await upsertManagerInboxNotice(db, { ...base, body: "And the other one?", messageId: "sid-2" });

    const row = rows.get(smsNoticeThreadId("manager-a", PHONE))!;
    expect(row.row_data.rootChannel).toBe("sms");
    const turns = inboxThreadMessages(thread(row));
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.channel)).toEqual(["sms", "sms"]);
    expect(lastInboundChannelOf(thread(row))).toBe("sms");
  });
});

describe("revision of append_manager_sms_inbox_notice (migration text)", () => {
  const sql = readFileSync("supabase/migrations/20261008230000_sms_notice_channel_stamp.sql", "utf8");

  it("replaces the same function signature idempotently and keeps the service-only ACL", () => {
    expect(sql).toMatch(/create or replace function public\.append_manager_sms_inbox_notice\(/);
    expect(sql).toMatch(/p_control_keys text\[\]\s*\) returns jsonb/);
    expect(sql).toMatch(/revoke all on function public\.append_manager_sms_inbox_notice\(uuid,text,text,text,jsonb,jsonb,boolean,text\[\]\)\s+from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.append_manager_sms_inbox_notice\([^)]*\)\s+to service_role/);
    expect(sql).not.toMatch(/security definer/i);
  });

  it("stamps sms on the root and on the appended message unless the caller named a channel", () => {
    expect(sql).toMatch(/'rootChannel', coalesce\(nullif\(p_incoming->>'rootChannel', ''\), 'sms'\)/);
    expect(sql).toMatch(/'channel', coalesce\(nullif\(p_message->>'channel', ''\), 'sms'\)/);
    // The insert and the append both use the stamped values, not the raw params.
    expect(sql).toMatch(/p_thread_type, v_incoming, clock_timestamp\(\)/);
    expect(sql).toMatch(/v_messages \|\| jsonb_build_array\(v_message\)/);
  });

  it("keeps the reopen-and-archive transaction from the version it revises", () => {
    expect(sql).toMatch(/v_reopens := p_inbound and v_thread\.row_data->>'folder' = 'trash'/);
    expect(sql).toMatch(/update public\.manager_tour_followup_controls set/);
  });
});

describe("lastInboundChannelOf reads already-stored SMS notice rows as text", () => {
  const legacy = (over: Partial<PersistedInboxThread>): PersistedInboxThread => ({
    id: "sms_notice_abc",
    folder: "inbox",
    from: PHONE,
    email: "",
    subject: "Text",
    preview: "hi",
    body: "hi",
    time: "Oct 8, 2026",
    unread: true,
    rootOutbound: false,
    ...over,
  });

  it("falls back to sms for an unstamped leasing notice (threadType)", () => {
    expect(lastInboundChannelOf(legacy({ threadType: "claw_leasing_sms" }))).toBe("sms");
  });

  it("falls back to sms for an unstamped notice that only has the notice phone", () => {
    expect(lastInboundChannelOf(legacy({ smsNoticePhone: PHONE }))).toBe("sms");
  });

  it("applies to appended unstamped inbound turns too", () => {
    const row = legacy({
      threadType: "claw_resident_sms",
      messages: [{ id: "m2", from: PHONE, body: "again", at: "Oct 8, 2026", outbound: false }],
    });
    expect(lastInboundChannelOf(row)).toBe("sms");
  });

  it("leaves an ordinary unstamped thread unguessed", () => {
    expect(lastInboundChannelOf(legacy({ id: "thr-1", from: "Dana", email: "dana@example.com" }))).toBeNull();
  });

  it("keeps an explicit stamp over the fallback", () => {
    expect(lastInboundChannelOf(legacy({ threadType: "claw_leasing_sms", rootChannel: "email" }))).toBe("email");
  });
});

describe("a server auto-reply is a sent turn on the notice thread", () => {
  it("appends the reply as outbound so the inbox has nothing left to draft", async () => {
    const { db, rows } = memoryDb();
    await upsertManagerInboxNotice(db, base);
    const id = smsNoticeThreadId("manager-a", PHONE);
    expect(inboxThreadManagerReplyPending(thread(rows.get(id)!))).toBe(true);

    const recorded = await recordAutoReplyOnSmsNotice(db, {
      managerUserId: "manager-a",
      counterpartyPhone: PHONE,
      text: "Yes, Room 2 is open. Want to tour?",
      inboundMessageId: "sid-1",
    });

    expect(recorded).toBe(true);
    const row = rows.get(id)!;
    const turns = inboxThreadMessages(thread(row));
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ outbound: true, channel: "sms", body: "Yes, Room 2 is open. Want to tour?" });
    expect(inboxThreadManagerReplyPending(thread(row))).toBe(false);
    // Still an inbox-folder conversation, root untouched.
    expect(row.row_data.folder).toBe("inbox");
    expect(row.row_data.rootOutbound).toBe(false);
  });

  it("is idempotent on the inbound id and never invents a thread", async () => {
    const { db, rows } = memoryDb();
    expect(
      await recordAutoReplyOnSmsNotice(db, { managerUserId: "manager-a", counterpartyPhone: PHONE, text: "hi", inboundMessageId: "sid-9" }),
    ).toBe(false);
    expect(rows.size).toBe(0);

    await upsertManagerInboxNotice(db, base);
    const args = { managerUserId: "manager-a", counterpartyPhone: PHONE, text: "Reply", inboundMessageId: "sid-1" };
    await recordAutoReplyOnSmsNotice(db, args);
    await recordAutoReplyOnSmsNotice(db, args);
    const row = rows.get(smsNoticeThreadId("manager-a", PHONE))!;
    expect(inboxThreadMessages(thread(row))).toHaveLength(2);
  });

  it("never throws when storage fails", async () => {
    const db = { from: () => { throw new Error("db down"); } } as unknown as SupabaseClient;
    await expect(
      recordAutoReplyOnSmsNotice(db, { managerUserId: "m", counterpartyPhone: PHONE, text: "x" }),
    ).resolves.toBe(false);
  });
});

describe("threads a server SMS agent answers", () => {
  it("are the leasing and resident SMS notices, nothing else", () => {
    expect(isServerAgentAnsweredSmsThread({ threadType: "claw_leasing_sms" })).toBe(true);
    expect(isServerAgentAnsweredSmsThread({ threadType: "claw_resident_sms" })).toBe(true);
    expect(isServerAgentAnsweredSmsThread({ thread_type: "claw_leasing_sms" })).toBe(true);
    expect(isServerAgentAnsweredSmsThread({ threadType: "portal_message" })).toBe(false);
    expect(isServerAgentAnsweredSmsThread({ threadType: null })).toBe(false);
    expect(isServerAgentAnsweredSmsThread({})).toBe(false);
  });
});
