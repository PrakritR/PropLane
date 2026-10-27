import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";
import { inboxThreadMessages, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { bubbleEventFields } from "@/lib/inbox-event-card";

/**
 * A3 (stay chat). The send path stamps an automated turn with its event kind, its card and its OWN record. The
 * record belongs to the turn: the thread keeps the first ref it was ever stamped with, so a payment card never
 * relabels a resident's conversation. A turn sent without a stamp is byte-for-byte what it always was.
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

function makeFakeDb(seed: StoredRow[]) {
  const rows: StoredRow[] = [...seed];
  const select = () => {
    const filters: [string, unknown][] = [];
    const value = (row: StoredRow, col: string): unknown =>
      col === "row_data->>email" ? row.row_data.email : col === "row_data->>folder" ? row.row_data.folder : (row as unknown as Record<string, unknown>)[col];
    const builder = {
      eq(col: string, val: unknown) { filters.push([col, val]); return builder; },
      order: () => builder,
      limit: () => builder,
      then<T>(resolve: (v: { data: StoredRow[]; error: null }) => T) {
        return Promise.resolve({ data: rows.filter((row) => filters.every(([c, v]) => value(row, c) === v)), error: null }).then(resolve);
      },
    };
    return builder;
  };
  return {
    from: () => ({
      select,
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

const SCOPE = "axis_portal_inbox_resident_v1";
const THREAD_REF = { kind: "lease" as const, id: "lease-1", label: "4709A" };
const PAYMENT_REF = { kind: "payment" as const, id: "chg-1", label: "Rent" };
const STAMP = {
  kind: "charge_created" as const,
  card: { title: "Rent due Nov 1 · $1,150.00", fact: "4709A 8th Ave" },
  recordRef: PAYMENT_REF,
};

const existing = (): StoredRow => ({
  id: "thr-res",
  scope: SCOPE,
  owner_user_id: "res-1",
  participant_email: "maya@example.com",
  thread_type: "portal_message",
  row_data: {
    folder: "inbox",
    email: "ambika@example.com",
    from: "Ambika",
    subject: "Lease",
    body: "Welcome Maya!",
    recordRef: THREAD_REF,
    messages: [],
  },
  updated_at: "2026-09-02T09:00:00.000Z",
});

const base = {
  scope: SCOPE,
  folder: "inbox" as const,
  ownerUserId: "res-1",
  participantEmail: "maya@example.com",
  otherPartyEmail: "ambika@example.com",
  fallbackId: "thr-new",
  fromName: "Ambika",
  subject: "Rent · Payment update",
  body: "A new $1,150.00 charge for “Rent” was added.",
  preview: "A new $1,150.00 charge",
  when: "Oct 25, 8:46 AM",
  unread: true,
  outbound: false,
  automated: true,
};

describe("an event card is stamped on the turn", () => {
  it("an append carries eventKind, eventCard and its own recordRef; the thread keeps its first ref", async () => {
    const db = makeFakeDb([existing()]);
    await deliverPortalMessageThreadSide(db, { ...base, event: STAMP });
    const rowData = db.__rows[0]!.row_data;
    expect(rowData.recordRef).toEqual(THREAD_REF);
    const messages = rowData.messages as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      automated: true,
      eventKind: "charge_created",
      eventCard: STAMP.card,
      recordRef: PAYMENT_REF,
    });
  });

  it("a brand-new conversation stamps the root turn and the thread's ref stays unset", async () => {
    const db = makeFakeDb([]);
    await deliverPortalMessageThreadSide(db, { ...base, event: STAMP });
    const rowData = db.__rows[0]!.row_data;
    expect(rowData.recordRef).toBeUndefined();
    expect(rowData).toMatchObject({ rootAutomated: true, rootEventKind: "charge_created", rootEventCard: STAMP.card, rootEventRecordRef: PAYMENT_REF });
    // And the root reads back as a stamped turn the bubble builders understand.
    const [root] = inboxThreadMessages({ id: "thr-new", ...rowData } as unknown as PersistedInboxThread);
    expect(bubbleEventFields(root)).toEqual({ eventKind: "charge_created", eventCard: STAMP.card, eventRecordRef: PAYMENT_REF });
  });

  it("a turn sent with no stamp is unchanged: no event keys, no turn record", async () => {
    const db = makeFakeDb([existing()]);
    await deliverPortalMessageThreadSide(db, { ...base });
    const message = (db.__rows[0]!.row_data.messages as Record<string, unknown>[])[0]!;
    expect(message.eventKind).toBeUndefined();
    expect(message.eventCard).toBeUndefined();
    expect(message.recordRef).toBeUndefined();
    expect(message.senderDisplayName).toBeUndefined();
    expect(bubbleEventFields(message)).toEqual({});
  });

  it("a co-host's reply carries its display label on the turn", async () => {
    const db = makeFakeDb([existing()]);
    await deliverPortalMessageThreadSide(db, { ...base, automated: false, outbound: true, senderDisplayName: "Dev · Co-host" });
    const message = (db.__rows[0]!.row_data.messages as Record<string, unknown>[])[0]!;
    expect(message.senderDisplayName).toBe("Dev · Co-host");
    expect(bubbleEventFields(message)).toEqual({ senderDisplayName: "Dev · Co-host" });
  });
});
