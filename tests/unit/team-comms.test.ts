import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const enqueueOwnerSms = vi.fn(async () => ({ ok: true as const, outboxId: "outbox-1", status: "queued", deduplicated: false }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...(args as [])),
}));

const resolveActiveManagerSendNumber = vi.fn(async () => "+15005550001");
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: (...args: unknown[]) => resolveActiveManagerSendNumber(...(args as [])),
}));

const isPhoneOptedOut = vi.fn(async () => false);
vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: (...args: unknown[]) => isPhoneOptedOut(...(args as [])),
}));

import {
  isTeamThreadId,
  mirrorTeamThreadMessageToSms,
  postTeamThreadMessage,
  resolveTeamMemberIds,
  teamThreadId,
} from "@/lib/team-comms.server";

type Row = Record<string, unknown> & { id?: string };

function fakeDb(seed: { threads?: Row[]; invites?: Row[]; profiles?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    portal_inbox_thread_records: seed.threads ?? [],
    account_link_invites: seed.invites ?? [],
    profiles: seed.profiles ?? [],
  };
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table]!;
    const matched = () => rows().filter((row) => filters.every((filter) => filter(row)));
    let mutation: Record<string, unknown> | null = null;
    let inserted: Row | null = null;
    let insertConflict = false;
    const q = {
      select() { return q; },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return q;
      },
      order() { return q; },
      limit(n: number) { return Promise.resolve({ data: matched().slice(0, n), error: null }); },
      insert(payload: Row) {
        const exists = rows().some((row) => row.id === payload.id);
        if (exists) { insertConflict = true; return Promise.resolve({ error: { message: "duplicate key" } }); }
        inserted = { ...payload };
        rows().push(inserted);
        return Promise.resolve({ error: null });
      },
      upsert(payload: Row, opts?: { onConflict?: string }) {
        const key = opts?.onConflict ?? "id";
        const existing = rows().find((row) => row[key] === payload[key]);
        if (existing) Object.assign(existing, payload);
        else rows().push({ ...payload });
        return Promise.resolve({ error: null });
      },
      update(payload: Record<string, unknown>) {
        mutation = payload;
        return q;
      },
      maybeSingle() {
        if (mutation) {
          const target = matched()[0];
          if (target) Object.assign(target, mutation);
          return Promise.resolve({ data: target ?? null, error: null });
        }
        return Promise.resolve({ data: matched()[0] ?? null, error: null });
      },
      then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
        return Promise.resolve({ data: matched(), error: null }).then(resolve);
      },
    };
    void insertConflict;
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tables };
}

describe("team-comms: thread identity + membership", () => {
  it("derives a deterministic per-owner thread id", () => {
    expect(teamThreadId("owner-1")).toBe("team-thread:owner-1");
    expect(isTeamThreadId(teamThreadId("owner-1"))).toBe(true);
    expect(isTeamThreadId("agent_notice_owner-1")).toBe(false);
  });

  it("resolves owner + accepted co-managers, owner first, never a pending/declined invite", async () => {
    const { db } = fakeDb({
      invites: [
        { inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" },
        { inviter_user_id: "owner-1", invitee_user_id: "co-2", status: "pending" },
        { inviter_user_id: "owner-2", invitee_user_id: "co-3", status: "accepted" },
      ],
    });
    const members = await resolveTeamMemberIds(db, "owner-1");
    expect(members).toEqual(["owner-1", "co-1"]);
  });
});

describe("team-comms: postTeamThreadMessage", () => {
  it("creates the thread on the first post, with the message as its root", async () => {
    const { db, tables } = fakeDb();
    const result = await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1",
      actorUserId: "owner-1",
      actorName: "Jamie",
      subject: "Tour confirmed",
      text: "A tour with Alex is confirmed for 4pm.",
      messageId: "action-event:evt-1:team:owner-1",
    });
    expect(result).toEqual({ ok: true, posted: true });
    expect(tables.portal_inbox_thread_records).toHaveLength(1);
    const row = tables.portal_inbox_thread_records[0]!;
    expect(row.thread_type).toBe("team");
    expect(row.owner_user_id).toBe("owner-1");
    const rowData = row.row_data as Record<string, unknown>;
    expect(rowData.body).toBe("A tour with Alex is confirmed for 4pm.");
    expect(rowData.from).toBe("Jamie");
    expect(rowData.messages).toEqual([]);
  });

  it("appends a second message to the same thread instead of creating a new one", async () => {
    const { db, tables } = fakeDb();
    await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1", actorName: "Jamie",
      subject: "s1", text: "first", messageId: "m1",
    });
    await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorUserId: "co-1", actorName: "Sam",
      subject: "s2", text: "second", messageId: "m2",
    });
    expect(tables.portal_inbox_thread_records).toHaveLength(1);
    const rowData = tables.portal_inbox_thread_records[0]!.row_data as Record<string, unknown>;
    const messages = rowData.messages as Array<{ id: string; body: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe("second");
    expect(rowData.preview).toBe("second");
  });

  it("is idempotent on messageId — a retried delivery never double-posts", async () => {
    const { db, tables } = fakeDb();
    await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1", actorName: "Jamie",
      subject: "s1", text: "first", messageId: "m1",
    });
    const retry = await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1", actorName: "Jamie",
      subject: "s1", text: "first", messageId: "m1",
    });
    expect(retry).toEqual({ ok: true, posted: false });
    const rowData = tables.portal_inbox_thread_records[0]!.row_data as Record<string, unknown>;
    expect((rowData.messages as unknown[])).toHaveLength(0);
  });

  it("rejects a call with no owner", async () => {
    const { db } = fakeDb();
    const result = await postTeamThreadMessage(db, {
      ownerManagerUserId: "  ", actorName: "Jamie", subject: "s", text: "t", messageId: "m",
    });
    expect(result.ok).toBe(false);
  });
});

describe("team-comms: mirrorTeamThreadMessageToSms (WS6)", () => {
  beforeEach(() => {
    enqueueOwnerSms.mockClear();
    resolveActiveManagerSendNumber.mockClear();
    isPhoneOptedOut.mockClear();
  });

  const daytimeNow = new Date("2026-09-16T20:00:00.000Z"); // ~1pm Pacific — outside quiet hours

  it("skips every member when the workspace has no sendable number", async () => {
    resolveActiveManagerSendNumber.mockResolvedValueOnce(null);
    const { db } = fakeDb({
      invites: [{ inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" }],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("defers every OTHER member during quiet hours for a non-urgent notice", async () => {
    const quietNow = new Date("2026-09-16T06:00:00.000Z"); // ~11pm Pacific — inside default quiet hours
    const { db } = fakeDb({
      invites: [
        { inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" },
        { inviter_user_id: "owner-1", invitee_user_id: "co-2", status: "accepted" },
      ],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: quietNow,
    });
    expect(outcomes.sort((a, b) => a.memberUserId.localeCompare(b.memberUserId))).toEqual([
      { memberUserId: "co-1", status: "deferred", reason: "quiet_hours" },
      { memberUserId: "co-2", status: "deferred", reason: "quiet_hours" },
    ]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("does not defer an urgent notice during quiet hours", async () => {
    const quietNow = new Date("2026-09-16T06:00:00.000Z");
    const { db } = fakeDb({
      invites: [{ inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" }],
      profiles: [{ id: "co-1", phone: "+15005550002", phone_verified_at: "2026-01-01T00:00:00.000Z" }],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1", urgent: true,
      subject: "s", text: "t", messageId: "m", now: quietNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "co-1", status: "sent" }]);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("never texts the acting manager themself", async () => {
    const { db } = fakeDb({
      invites: [{ inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" }],
      profiles: [{ id: "owner-1", phone: "+15005550003", phone_verified_at: "2026-01-01T00:00:00.000Z" }],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes.some((o) => o.memberUserId === "owner-1")).toBe(false);
  });

  it("skips a member with no verified phone, and sends to one who has consented", async () => {
    const { db } = fakeDb({
      invites: [
        { inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" },
        { inviter_user_id: "owner-1", invitee_user_id: "co-2", status: "accepted" },
      ],
      profiles: [
        { id: "co-1", phone: "", phone_verified_at: null },
        { id: "co-2", phone: "+15005550004", phone_verified_at: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1",
      subject: "Team", text: "hello", messageId: "m", now: daytimeNow,
    });
    expect(outcomes.sort((a, b) => a.memberUserId.localeCompare(b.memberUserId))).toEqual([
      { memberUserId: "co-1", status: "skipped", reason: "no_phone" },
      { memberUserId: "co-2", status: "sent" },
    ]);
    expect(enqueueOwnerSms).toHaveBeenCalledWith(
      expect.objectContaining({
        managerUserId: "owner-1",
        recipientPhone: "+15005550004",
        recipientUserId: "co-2",
        sendClass: "automated",
        purpose: "team_notice",
      }),
      db,
    );
  });

  it("skips a member who opted out via STOP", async () => {
    isPhoneOptedOut.mockResolvedValueOnce(true);
    const { db } = fakeDb({
      invites: [{ inviter_user_id: "owner-1", invitee_user_id: "co-1", status: "accepted" }],
      profiles: [{ id: "co-1", phone: "+15005550005", phone_verified_at: "2026-01-01T00:00:00.000Z" }],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "co-1", status: "skipped", reason: "stop" }]);
  });
});
