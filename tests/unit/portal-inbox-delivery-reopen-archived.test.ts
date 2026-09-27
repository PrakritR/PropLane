import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalMessageThreadSide, findExistingPortalMessageThread } from "@/lib/portal-inbox-delivery";

/**
 * Regression for the captain resurrection sweep, item 1:
 * `findExistingPortalMessageThread` used to require the matched row's CURRENT
 * folder to equal the side being delivered, so once a thread was archived
 * (folder "trash") the next message to/from that person inserted a
 * brand-new duplicate row instead of appending to the real, archived one —
 * history stayed stuck in Archived while a near-empty duplicate showed in
 * Active. The fix: match the archived row too (by its remembered
 * `previousFolder`), and only a genuinely INBOUND delivery may reopen it —
 * an outbound append into an archived thread keeps it archived.
 */

type StoredRow = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string;
  row_data: Record<string, unknown>;
  updated_at: string;
};

function readPath(row: StoredRow, col: string): unknown {
  if (col === "row_data->>email") return row.row_data.email;
  if (col === "row_data->>folder") return row.row_data.folder;
  return (row as unknown as Record<string, unknown>)[col];
}

function makeFakeDb(seed: StoredRow[]) {
  const rows: StoredRow[] = [...seed];

  function selectBuilder() {
    const filters: [string, unknown][] = [];
    const match = (row: StoredRow) => filters.every(([col, val]) => readPath(row, col) === val);
    const builder = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows.filter(match), error: null }).then(resolve);
      },
    };
    return builder;
  }

  return {
    from: () => ({
      select: () => selectBuilder(),
      upsert: (row: StoredRow) => {
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
    }),
    __rows: rows,
  } as unknown as SupabaseClient & { __rows: StoredRow[] };
}

const SCOPE = "axis_portal_inbox_manager_v1";

function archivedInboxRow(): StoredRow {
  return {
    id: "thr-archived-inbox",
    scope: SCOPE,
    owner_user_id: null,
    participant_email: "recipient@test.example",
    thread_type: "portal_message",
    row_data: {
      folder: "trash",
      previousFolder: "inbox",
      email: "person@test.example",
      from: "Person",
      subject: "Hi",
      body: "Original message",
      messages: [{ id: "m-1", from: "Person", body: "Original message", at: "Sep 1, 9:00 AM", outbound: false }],
    },
    updated_at: "2026-09-01T09:00:00.000Z",
  };
}

function archivedSentRow(): StoredRow {
  return {
    id: "thr-archived-sent",
    scope: SCOPE,
    owner_user_id: "mgr-1",
    participant_email: null,
    thread_type: "portal_message",
    row_data: {
      folder: "trash",
      previousFolder: "sent",
      email: "person@test.example",
      from: "You",
      subject: "Hi",
      body: "Original message",
      messages: [{ id: "m-1", from: "You", body: "Original message", at: "Sep 1, 9:00 AM", outbound: true }],
    },
    updated_at: "2026-09-01T09:00:00.000Z",
  };
}

describe("findExistingPortalMessageThread matches an archived row", () => {
  it("matches an inbox-side archived row by its remembered previousFolder", async () => {
    const db = makeFakeDb([archivedInboxRow()]);
    const found = await findExistingPortalMessageThread(db, {
      scope: SCOPE,
      folder: "inbox",
      ownerUserId: null,
      participantEmail: "recipient@test.example",
      otherPartyEmail: "person@test.example",
    });
    expect(found?.id).toBe("thr-archived-inbox");
    expect(found?.archived).toBe(true);
  });

  it("never matches the OTHER side's own archived row", async () => {
    const db = makeFakeDb([archivedSentRow()]);
    const found = await findExistingPortalMessageThread(db, {
      scope: SCOPE,
      folder: "inbox",
      ownerUserId: null,
      participantEmail: "recipient@test.example",
      otherPartyEmail: "person@test.example",
    });
    expect(found).toBeNull();
  });
});

describe("deliverPortalMessageThreadSide reopening policy", () => {
  it("appends to the archived thread instead of creating a duplicate, for both directions", async () => {
    const inboundDb = makeFakeDb([archivedInboxRow()]);
    const inboundResult = await deliverPortalMessageThreadSide(inboundDb, {
      scope: SCOPE,
      folder: "inbox",
      ownerUserId: null,
      participantEmail: "recipient@test.example",
      otherPartyEmail: "person@test.example",
      fallbackId: "thr-new-should-not-be-used",
      fromName: "Person",
      subject: "Hi again",
      body: "New inbound message",
      preview: "New inbound message",
      when: "Sep 10, 9:00 AM",
      unread: true,
      outbound: false,
    });
    expect(inboundResult).toEqual(expect.objectContaining({ action: "append", threadId: "thr-archived-inbox" }));
    expect((inboundDb as unknown as { __rows: StoredRow[] }).__rows).toHaveLength(1);

    const outboundDb = makeFakeDb([archivedSentRow()]);
    const outboundResult = await deliverPortalMessageThreadSide(outboundDb, {
      scope: SCOPE,
      folder: "sent",
      ownerUserId: "mgr-1",
      participantEmail: null,
      otherPartyEmail: "person@test.example",
      fallbackId: "thr-new-should-not-be-used",
      fromName: "You",
      subject: "Hi again",
      body: "New outbound message",
      preview: "New outbound message",
      when: "Sep 10, 9:00 AM",
      unread: false,
      outbound: true,
    });
    expect(outboundResult).toEqual(expect.objectContaining({ action: "append", threadId: "thr-archived-sent" }));
    expect((outboundDb as unknown as { __rows: StoredRow[] }).__rows).toHaveLength(1);
  });

  it("only an INBOUND append reopens the thread; an outbound append keeps it archived", async () => {
    const inboundDb = makeFakeDb([archivedInboxRow()]);
    await deliverPortalMessageThreadSide(inboundDb, {
      scope: SCOPE,
      folder: "inbox",
      ownerUserId: null,
      participantEmail: "recipient@test.example",
      otherPartyEmail: "person@test.example",
      fallbackId: "thr-new",
      fromName: "Person",
      subject: "Hi again",
      body: "New inbound message",
      preview: "New inbound message",
      when: "Sep 10, 9:00 AM",
      unread: true,
      outbound: false,
    });
    const inboundRow = (inboundDb as unknown as { __rows: StoredRow[] }).__rows[0]!;
    expect(inboundRow.row_data.folder).toBe("inbox");
    expect(inboundRow.row_data.previousFolder).toBeUndefined();
    expect((inboundRow.row_data.messages as unknown[]).length).toBe(2);

    const outboundDb = makeFakeDb([archivedSentRow()]);
    await deliverPortalMessageThreadSide(outboundDb, {
      scope: SCOPE,
      folder: "sent",
      ownerUserId: "mgr-1",
      participantEmail: null,
      otherPartyEmail: "person@test.example",
      fallbackId: "thr-new",
      fromName: "You",
      subject: "Hi again",
      body: "New outbound message",
      preview: "New outbound message",
      when: "Sep 10, 9:00 AM",
      unread: false,
      outbound: true,
    });
    const outboundRow = (outboundDb as unknown as { __rows: StoredRow[] }).__rows[0]!;
    expect(outboundRow.row_data.folder).toBe("trash");
    // The message still lands in the (still-archived) thread — never a
    // silently dropped write and never a fresh duplicate row.
    expect((outboundRow.row_data.messages as unknown[]).length).toBe(2);
  });
});
