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
  assertTeamThreadMember,
  isTeamThreadId,
  mirrorTeamThreadMessageToSms,
  parseTeamThreadId,
  postTeamThreadMessage,
  resolveTeamNoticeRecipientIds,
  teamThreadId,
} from "@/lib/team-comms.server";

type Row = Record<string, unknown> & { id?: string };

function fakeDb(seed: { threads?: Row[]; invites?: Row[]; profiles?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    portal_inbox_thread_records: seed.threads ?? [],
    account_link_invites: seed.invites ?? [],
    profiles: seed.profiles ?? [],
  };
  let clock = 0;
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    const rows = () => tables[table]!;
    const matched = () => rows().filter((row) => filters.every((filter) => filter(row)));
    let mutation: Record<string, unknown> | null = null;
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
        if (exists) return Promise.resolve({ error: { message: "duplicate key" } });
        rows().push({ ...payload, updated_at: payload.updated_at ?? `t${++clock}` });
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
          return Promise.resolve({ data: target ? { id: target.id } : null, error: null });
        }
        const found = matched()[0];
        return Promise.resolve({ data: found ? { ...found } : null, error: null });
      },
      then<T>(resolve: (value: { data: Row[]; error: null }) => T) {
        return Promise.resolve({ data: matched(), error: null }).then(resolve);
      },
    };
    return q;
  };
  return { db: { from } as unknown as SupabaseClient, tables };
}

/** An accepted co-manager link assigning `propertyIds` with `perms` per module (legacy `true` = full). */
function invite(owner: string, invitee: string, propertyIds: string[], perms: Record<string, unknown>, status = "accepted"): Row {
  return {
    inviter_user_id: owner,
    invitee_user_id: invitee,
    status,
    assigned_property_ids: propertyIds,
    property_co_manager_permissions: Object.fromEntries(propertyIds.map((id) => [id, perms])),
  };
}

describe("team-comms: thread identity + membership", () => {
  it("derives a deterministic per-owner, per-house thread id", () => {
    expect(teamThreadId("owner-1")).toBe("team-thread:owner-1");
    expect(teamThreadId("owner-1", "prop-1")).toBe("team-thread:owner-1:prop-1");
    expect(isTeamThreadId(teamThreadId("owner-1"))).toBe(true);
    expect(isTeamThreadId("agent_notice_owner-1")).toBe(false);
    expect(parseTeamThreadId("team-thread:owner-1:prop-1")).toEqual({ ownerManagerUserId: "owner-1", propertyId: "prop-1" });
    expect(parseTeamThreadId("team-thread:owner-1")).toEqual({ ownerManagerUserId: "owner-1", propertyId: null });
    expect(parseTeamThreadId("agent_notice_owner-1")).toBeNull();
  });

  it("resolves recipients deny-by-default: the owner plus co-managers granted THAT module on THAT house", async () => {
    const { db } = fakeDb({
      invites: [
        invite("owner-1", "co-payments", ["prop-1"], { payments: true }),
        invite("owner-1", "co-other-house", ["prop-2"], { payments: true }),
        invite("owner-1", "co-empty", ["prop-1"], {}),
        invite("owner-1", "co-pending", ["prop-1"], { payments: true }, "pending"),
        invite("owner-2", "co-of-someone-else", ["prop-1"], { payments: true }),
      ],
    });
    const recipients = await resolveTeamNoticeRecipientIds(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments",
    });
    expect(recipients.sort()).toEqual(["co-payments", "owner-1"]);
  });

  it("a notice about no house reaches the owner alone", async () => {
    const { db } = fakeDb({ invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })] });
    expect(await resolveTeamNoticeRecipientIds(db, { ownerManagerUserId: "owner-1", module: "payments" })).toEqual(["owner-1"]);
  });

  it("assertTeamThreadMember: owner always; a co-manager only with Communication on that house", async () => {
    const { db } = fakeDb({
      invites: [
        invite("owner-1", "co-inbox", ["prop-1"], { inbox: { read: true, edit: true } }),
        invite("owner-1", "co-read-only", ["prop-1"], { inbox: { read: true } }),
        invite("owner-1", "co-no-inbox", ["prop-1"], { payments: true }),
      ],
    });
    const on = (userId: string, level: "read" | "edit", propertyId: string | null = "prop-1") =>
      assertTeamThreadMember(db, { ownerManagerUserId: "owner-1", propertyId, userId, level });
    expect(await on("owner-1", "edit", null)).toBe(true);
    expect(await on("co-inbox", "edit")).toBe(true);
    expect(await on("co-read-only", "read")).toBe(true);
    expect(await on("co-read-only", "edit")).toBe(false);
    expect(await on("co-no-inbox", "read")).toBe(false);
    expect(await on("co-inbox", "read", null)).toBe(false);
  });
});

describe("team-comms: postTeamThreadMessage", () => {
  it("creates the house's thread on the first post, tagged with the property, with the message as its root", async () => {
    const { db, tables } = fakeDb();
    const result = await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1",
      propertyId: "prop-1",
      propertyTitle: "Ballard House",
      actorUserId: "owner-1",
      actorName: "Jamie",
      subject: "Tour confirmed",
      text: "A tour with Alex is confirmed for 4pm.",
      messageId: "action-event:evt-1:team:owner-1",
    });
    expect(result).toEqual({ ok: true, posted: true });
    expect(tables.portal_inbox_thread_records).toHaveLength(1);
    const row = tables.portal_inbox_thread_records[0]!;
    expect(row.id).toBe("team-thread:owner-1:prop-1");
    expect(row.thread_type).toBe("team");
    expect(row.owner_user_id).toBe("owner-1");
    const rowData = row.row_data as Record<string, unknown>;
    expect(rowData.propertyId).toBe("prop-1");
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

  it("two appends racing on the same thread both land — the loser re-reads and retries its CAS", async () => {
    const { db, tables } = fakeDb();
    await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorName: "Jamie", subject: "s0", text: "root", messageId: "m0",
    });
    // Both posters read the row before either writes: the fake's CAS on
    // `updated_at` makes the second write miss and loop.
    const thread = tables.portal_inbox_thread_records[0]!;
    const originalFrom = (db as unknown as { from: (t: string) => unknown }).from;
    let reads = 0;
    (db as unknown as { from: unknown }).from = (table: string) => {
      const q = originalFrom(table) as { maybeSingle: () => Promise<unknown> };
      const realMaybeSingle = q.maybeSingle.bind(q);
      q.maybeSingle = async () => {
        const result = await realMaybeSingle();
        reads += 1;
        if (reads === 1) thread.updated_at = "bumped-by-a-concurrent-append";
        return result;
      };
      return q;
    };
    const result = await postTeamThreadMessage(db, {
      ownerManagerUserId: "owner-1", actorName: "Sam", subject: "s1", text: "first", messageId: "m1",
    });
    expect(result).toEqual({ ok: true, posted: true });
    const rowData = thread.row_data as Record<string, unknown>;
    expect((rowData.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(["m1"]);
    expect(reads).toBeGreaterThan(1);
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
  const verified = (id: string, phone: string): Row => ({ id, phone, phone_verified_at: "2026-01-01T00:00:00.000Z" });

  it("skips every member when the workspace has no sendable number", async () => {
    resolveActiveManagerSendNumber.mockResolvedValueOnce(null);
    const { db } = fakeDb({ invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })] });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("during quiet hours the text is still enqueued — the dispatcher defers it durably rather than this dropping it", async () => {
    const quietNow = new Date("2026-09-16T06:00:00.000Z"); // ~11pm Pacific — inside default quiet hours
    const { db } = fakeDb({
      invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })],
      profiles: [verified("co-1", "+15005550002")],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: quietNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "co-1", status: "sent" }]);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
  });

  it("never texts the acting manager themself", async () => {
    const { db } = fakeDb({
      invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })],
      profiles: [verified("owner-1", "+15005550003")],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes.some((o) => o.memberUserId === "owner-1")).toBe(false);
  });

  it("texts the owner when a co-manager acted", async () => {
    const { db } = fakeDb({
      invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })],
      profiles: [verified("owner-1", "+15005550003")],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "co-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "owner-1", status: "sent" }]);
  });

  it("R5: a co-manager without the module on that house — or with empty permissions — is never texted", async () => {
    const { db } = fakeDb({
      invites: [
        invite("owner-1", "co-granted", ["prop-1"], { payments: true }),
        invite("owner-1", "co-other-module", ["prop-1"], { leases: true }),
        invite("owner-1", "co-other-house", ["prop-2"], { payments: true }),
        invite("owner-1", "co-empty", ["prop-1"], {}),
      ],
      profiles: [
        verified("co-granted", "+15005550010"),
        verified("co-other-module", "+15005550011"),
        verified("co-other-house", "+15005550012"),
        verified("co-empty", "+15005550013"),
      ],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
      subject: "Payment received", text: "$1,200 was received.", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "co-granted", status: "sent" }]);
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
    expect(enqueueOwnerSms).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: "co-granted", propertyId: "prop-1", purpose: "team_notice" }),
      db,
    );
  });

  it("a notice about no house texts nobody but the owner's side of the team", async () => {
    const { db } = fakeDb({
      invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })],
      profiles: [verified("co-1", "+15005550004")],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", module: "payments", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([]);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("skips a member with no verified phone, and sends to one who has consented", async () => {
    const { db } = fakeDb({
      invites: [
        invite("owner-1", "co-1", ["prop-1"], { payments: true }),
        invite("owner-1", "co-2", ["prop-1"], { payments: true }),
      ],
      profiles: [
        { id: "co-1", phone: "", phone_verified_at: null },
        verified("co-2", "+15005550004"),
      ],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
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
      invites: [invite("owner-1", "co-1", ["prop-1"], { payments: true })],
      profiles: [verified("co-1", "+15005550005")],
    });
    const outcomes = await mirrorTeamThreadMessageToSms(db, {
      ownerManagerUserId: "owner-1", propertyId: "prop-1", module: "payments", actorUserId: "owner-1",
      subject: "s", text: "t", messageId: "m", now: daytimeNow,
    });
    expect(outcomes).toEqual([{ memberUserId: "co-1", status: "skipped", reason: "stop" }]);
  });
});
