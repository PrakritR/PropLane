import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/push-notifications.server", () => ({
  sendPushToUser: vi.fn().mockResolvedValue({ sent: 1 }),
}));

import type { SupabaseClient } from "@supabase/supabase-js";
import { commitInboxThreadReply, deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { isValidRecordRef, normalizeRecordRef } from "@/lib/portals/record-kinds";
import { recordRefFromReminderRow } from "@/lib/reminders/reminder-record-ref";
import type { ReminderPayload } from "@/lib/reminders/render";

type StoredRow = Record<string, unknown> & { id: string };

/** Same minimal chainable Supabase stand-in as portal-inbox-delivery-push.test.ts. */
function makeFakeDb(seedProfiles: StoredRow[]) {
  const tables: Record<string, StoredRow[]> = {
    profiles: [...seedProfiles],
    portal_inbox_thread_records: [],
    portal_outbound_mail_records: [],
  };

  function makeQuery(table: string) {
    const rows = () => (tables[table] ??= []);
    const eqFilters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    const match = (r: StoredRow) =>
      eqFilters.every(([c, v]) => (r as Record<string, unknown>)[c] === v) &&
      inFilters.every(([c, vals]) => vals.includes((r as Record<string, unknown>)[c]));
    const builder = {
      select() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqFilters.push([col, val]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        inFilters.push([col, vals]);
        return builder;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows().find(match) ?? null, error: null });
      },
      upsert(row: StoredRow) {
        const idx = rows().findIndex((r) => r.id === row.id);
        if (idx >= 0) rows()[idx] = { ...rows()[idx], ...row };
        else rows().push({ ...row });
        return Promise.resolve({ error: null });
      },
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows().filter(match), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return {
    from: (table: string) => makeQuery(table),
    __rows: (table: string) => tables[table] ?? [],
  } as unknown as SupabaseClient & { __rows: (table: string) => StoredRow[] };
}

const SENDER_ID = "mgr-1";
const SENDER_EMAIL = "manager@axis.test";
const PROFILES: StoredRow[] = [
  { id: SENDER_ID, email: SENDER_EMAIL, role: "manager" },
  { id: "user-res-1", email: "res1@axis.test", role: "resident" },
];

describe("recordRef validation", () => {
  it("rejects a malformed recordRef (bad kind)", () => {
    expect(isValidRecordRef({ kind: "not-a-kind", id: "1", label: "x" })).toBe(false);
    expect(normalizeRecordRef({ kind: "not-a-kind", id: "1", label: "x" })).toBeNull();
  });

  it("rejects a recordRef missing id or label", () => {
    expect(normalizeRecordRef({ kind: "payment", id: "", label: "x" })).toBeNull();
    expect(normalizeRecordRef({ kind: "payment", id: "1", label: "" })).toBeNull();
    expect(normalizeRecordRef({ kind: "payment", label: "x" })).toBeNull();
  });

  it("rejects non-string id/label and non-object values", () => {
    expect(normalizeRecordRef({ kind: "payment", id: 1, label: "x" })).toBeNull();
    expect(normalizeRecordRef("payment:1")).toBeNull();
    expect(normalizeRecordRef(null)).toBeNull();
  });

  it("accepts a well-formed recordRef and trims it", () => {
    expect(normalizeRecordRef({ kind: "lease", id: "  lease-1  ", label: "  Lease  " })).toEqual({
      kind: "lease",
      id: "lease-1",
      label: "Lease",
    });
  });
});

describe("send paths stamp recordRef when given", () => {
  it("deliverPortalInboxMessage stamps recordRef onto a newly created thread (both sent and inbox sides)", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, {
      senderUserId: SENDER_ID,
      senderEmail: SENDER_EMAIL,
      fromName: "Property manager",
      senderRole: "admin" as const,
      subject: "Rent · September",
      text: "Rent for September is due tomorrow.",
      toUserIds: ["user-res-1"],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      recordRef: { kind: "payment", id: "chg-1", label: "Rent · September" },
    });

    const threads = (db as unknown as { __rows: (t: string) => StoredRow[] }).__rows("portal_inbox_thread_records");
    expect(threads.length).toBeGreaterThan(0);
    for (const thread of threads) {
      const rowData = thread.row_data as Record<string, unknown>;
      expect(rowData.recordRef).toEqual({ kind: "payment", id: "chg-1", label: "Rent · September" });
    }
  });

  it("deliverPortalInboxMessage never stamps a recordRef when the caller passes none", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, {
      senderUserId: SENDER_ID,
      senderEmail: SENDER_EMAIL,
      fromName: "Property manager",
      senderRole: "admin" as const,
      subject: "Hi",
      text: "Just checking in.",
      toUserIds: ["user-res-1"],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
    });

    const threads = (db as unknown as { __rows: (t: string) => StoredRow[] }).__rows("portal_inbox_thread_records");
    for (const thread of threads) {
      expect((thread.row_data as Record<string, unknown>).recordRef).toBeUndefined();
    }
  });

  it("a malformed recordRef is dropped rather than trusted (never stamped)", async () => {
    const db = makeFakeDb(PROFILES);
    await deliverPortalInboxMessage(db, {
      senderUserId: SENDER_ID,
      senderEmail: SENDER_EMAIL,
      fromName: "Property manager",
      senderRole: "admin" as const,
      subject: "Hi",
      text: "Just checking in.",
      toUserIds: ["user-res-1"],
      deliverToPortalInbox: true,
      deliverViaEmail: false,
      // @ts-expect-error — deliberately malformed input, mirrors an untrusted caller.
      recordRef: { kind: "not-a-kind", id: "1", label: "x" },
    });

    const threads = (db as unknown as { __rows: (t: string) => StoredRow[] }).__rows("portal_inbox_thread_records");
    for (const thread of threads) {
      expect((thread.row_data as Record<string, unknown>).recordRef).toBeUndefined();
    }
  });

  it("commitInboxThreadReply stamps a recordRef onto a thread that has none yet", async () => {
    const db = makeFakeDb(PROFILES);
    const threadId = "thread-1";
    await (db.from("portal_inbox_thread_records") as unknown as { upsert: (r: StoredRow) => Promise<unknown> }).upsert({
      id: threadId,
      scope: "axis_portal_inbox_manager_v1",
      owner_user_id: SENDER_ID,
      participant_email: null,
      row_data: { messages: [], time: "Sep 1, 1:00 PM" },
    });

    await commitInboxThreadReply(
      db,
      { threadId, scope: "axis_portal_inbox_manager_v1", ownerUserId: SENDER_ID, participantEmail: null, threadType: "portal_message", rowData: {} },
      { fromName: "Property manager", text: "Following up", recordRef: { kind: "lease", id: "lease-9", label: "Lease" } },
    );

    const threads = (db as unknown as { __rows: (t: string) => StoredRow[] }).__rows("portal_inbox_thread_records");
    const thread = threads.find((t) => t.id === threadId)!;
    expect((thread.row_data as Record<string, unknown>).recordRef).toEqual({ kind: "lease", id: "lease-9", label: "Lease" });
  });

  it("commitInboxThreadReply NEVER overwrites an already-stamped recordRef with a different one", async () => {
    const db = makeFakeDb(PROFILES);
    const threadId = "thread-2";
    await (db.from("portal_inbox_thread_records") as unknown as { upsert: (r: StoredRow) => Promise<unknown> }).upsert({
      id: threadId,
      scope: "axis_portal_inbox_manager_v1",
      owner_user_id: SENDER_ID,
      participant_email: null,
      row_data: { messages: [], time: "Sep 1, 1:00 PM", recordRef: { kind: "payment", id: "chg-1", label: "Rent · September" } },
    });

    await commitInboxThreadReply(
      db,
      { threadId, scope: "axis_portal_inbox_manager_v1", ownerUserId: SENDER_ID, participantEmail: null, threadType: "portal_message", rowData: {} },
      { fromName: "Resident", text: "Paid, thanks!", recordRef: { kind: "lease", id: "lease-9", label: "Lease" } },
    );

    const threads = (db as unknown as { __rows: (t: string) => StoredRow[] }).__rows("portal_inbox_thread_records");
    const thread = threads.find((t) => t.id === threadId)!;
    expect((thread.row_data as Record<string, unknown>).recordRef).toEqual({
      kind: "payment",
      id: "chg-1",
      label: "Rent · September",
    });
  });
});

describe("automated reminders stamp a recordRef from their subject row (docs/agents/communication-inbox.md § recordRef)", () => {
  it("an automated payment reminder carries the charge ref", () => {
    const payload: ReminderPayload = { chargeTitle: "Rent · September" };
    expect(recordRefFromReminderRow("payment_manager", "chg-123", payload, "Rent is due")).toEqual({
      kind: "payment",
      id: "chg-123",
      label: "Rent · September",
    });
  });

  it("falls back to the rendered subject when the payload has no title-ish field", () => {
    expect(recordRefFromReminderRow("lease", "lease-5", {}, "Your lease is expiring")).toEqual({
      kind: "lease",
      id: "lease-5",
      label: "Your lease is expiring",
    });
  });

  it("a booking reminder resolves only a `stay:` subject id, not a channel-sourced one", () => {
    expect(recordRefFromReminderRow("booking", "stay:abc123", { title: "Guest stay" }, "Upcoming stay")).toEqual({
      kind: "booking",
      id: "abc123",
      label: "Guest stay",
    });
    expect(recordRefFromReminderRow("booking", "channel:conn-1:range-1", {}, "Upcoming stay")).toBeNull();
  });

  it("an unmapped reminder kind returns no recordRef rather than a guessed one", () => {
    expect(recordRefFromReminderRow("task_overdue", "task-1", {}, "Task overdue")).toBeNull();
  });
});
