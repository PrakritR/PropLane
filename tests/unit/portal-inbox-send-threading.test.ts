import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import { inboxThreadMessages, type PersistedInboxThread } from "@/lib/portal-inbox-storage";

/**
 * Regression: sending several messages to the SAME person must collapse into ONE
 * thread (append), not spawn a fresh thread row per message. Before the send
 * paths reused the person's existing thread, each `deliverPortalInboxMessage`
 * minted `msg_<sender>_<ts>_<rand>` (and `msg_inbox_<ts>_<rand>`), so N sends =
 * N rows on both the sender's Sent view and the recipient's inbox.
 *
 * Driven with an admin sender so the relationship-scope gate short-circuits
 * (`filterRecipientsBySenderScope` returns everything for an admin), keeping the
 * test focused on the thread-collapsing behavior.
 */

type StoredRow = Record<string, unknown> & { id: string };

/** Minimal chainable Supabase stand-in covering the admin send path. */
function makeFakeDb() {
  const tables: Record<string, StoredRow[]> = {
    profiles: [],
    portal_inbox_thread_records: [],
    portal_outbound_mail_records: [],
  };

  function makeQuery(table: string) {
    const rows = () => (tables[table] ??= []);
    const filters: [string, unknown][] = [];
    const resolveColumn = (r: StoredRow, col: string): unknown => {
      const jsonPath = col.match(/^(\w+)->>(\w+)$/);
      if (jsonPath) {
        const [, column, key] = jsonPath;
        const nested = (r as Record<string, unknown>)[column!];
        const value = nested && typeof nested === "object" ? (nested as Record<string, unknown>)[key!] : undefined;
        return value == null ? value : String(value);
      }
      return (r as Record<string, unknown>)[col];
    };
    const match = (r: StoredRow) => filters.every(([c, v]) => resolveColumn(r, c) === v);
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
        filters.push([col, val]);
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

  const db = { from: (table: string) => makeQuery(table) } as unknown as SupabaseClient;
  return { db, tables };
}

const SENDER_ID = "mgr_admin_1";
const SENDER_EMAIL = "manager@axis.test";
const RECIPIENT = "founders@axis-seattle-housing.com";

function baseOpts(text: string, subject: string) {
  return {
    senderUserId: SENDER_ID,
    senderEmail: SENDER_EMAIL,
    fromName: "Property manager",
    senderRole: "admin" as const,
    subject,
    text,
    toEmails: [RECIPIENT],
    deliverToPortalInbox: true,
    deliverViaEmail: false,
  };
}

describe("deliverPortalInboxMessage person-thread collapsing", () => {
  it("does not append a replayed action-event message twice", async () => {
    const { db, tables } = makeFakeDb();
    const opts = { ...baseOpts("payment received", "Payment update"), messageId: "action-event:evt-1:resident:user-1" };

    await deliverPortalInboxMessage(db, opts);
    await deliverPortalInboxMessage(db, opts);

    for (const row of tables.portal_inbox_thread_records!) {
      expect(inboxThreadMessages(row.row_data as PersistedInboxThread)).toHaveLength(1);
    }
  });

  it("appends repeated sends to the same person into ONE sent + ONE inbox thread", async () => {
    const { db, tables } = makeFakeDb();

    await deliverPortalInboxMessage(db, baseOpts("first message", "s"));
    await deliverPortalInboxMessage(db, baseOpts("second message", "Re: s"));

    const all = tables.portal_inbox_thread_records!;
    const sent = all.filter((r) => (r.row_data as PersistedInboxThread).folder === "sent");
    const inbox = all.filter((r) => (r.row_data as PersistedInboxThread).folder === "inbox");

    // One thread per person on BOTH sides (was two before the fix).
    expect(sent).toHaveLength(1);
    expect(inbox).toHaveLength(1);

    const sentThread = sent[0]!.row_data as PersistedInboxThread;
    const inboxThread = inbox[0]!.row_data as PersistedInboxThread;

    // Both messages live inside the single thread, in order.
    const sentMessages = inboxThreadMessages(sentThread);
    expect(sentMessages.map((m) => m.body)).toEqual(["first message", "second message"]);
    const inboxMessages = inboxThreadMessages(inboxThread);
    expect(inboxMessages.map((m) => m.body)).toEqual(["first message", "second message"]);

    // Preview reflects the latest message; the recipient's copy stays unread.
    expect(sentThread.preview).toContain("second");
    expect(inboxThread.preview).toContain("second");
    expect(inboxThread.unread).toBe(true);

    // The appended inbound turn on the recipient's copy is marked inbound so the
    // bubble renderer does not treat it as the owner's own reply.
    expect(inboxMessages[1]?.outbound).toBe(false);
  });

  /**
   * Regression for F-COMM-1. The append branch used to preserve the existing
   * `subject`, so a person-thread was labelled forever by the FIRST message ever
   * sent to that person. In the dev data the first send was a one-character "N",
   * so nine of fourteen conversations rendered their subject as "N" — including
   * a thread whose newest message was a lease titled "Your lease for ...".
   */
  it("advances the thread subject to the latest message", async () => {
    const { db, tables } = makeFakeDb();

    await deliverPortalInboxMessage(db, baseOpts("first message", "N"));
    await deliverPortalInboxMessage(
      db,
      baseOpts("your lease is ready", "Your lease for Cascade Lofts · Unit 2A is ready to sign"),
    );

    const all = tables.portal_inbox_thread_records!;
    for (const row of all) {
      const thread = row.row_data as PersistedInboxThread;
      expect(thread.subject).toBe("Your lease for Cascade Lofts · Unit 2A is ready to sign");
    }
  });

  it("keeps the root message body as real history when the subject advances", async () => {
    const { db, tables } = makeFakeDb();

    await deliverPortalInboxMessage(db, baseOpts("first message", "N"));
    await deliverPortalInboxMessage(db, baseOpts("second message", "New subject"));

    const sent = tables.portal_inbox_thread_records!.find(
      (r) => (r.row_data as PersistedInboxThread).folder === "sent",
    )!;
    const thread = sent.row_data as PersistedInboxThread;
    // `body` is the first message's text, not a display field — advancing the
    // subject must not rewrite the conversation's history.
    expect(thread.body).toBe("first message");
    expect(inboxThreadMessages(thread).map((m) => m.body)).toEqual(["first message", "second message"]);
  });

  it("rejects a blank-subject send outright, leaving the thread label intact", async () => {
    const { db, tables } = makeFakeDb();

    await deliverPortalInboxMessage(db, baseOpts("first message", "Move-in packet"));
    const blank = await deliverPortalInboxMessage(db, {
      ...baseOpts("second message", "Move-in packet"),
      subject: "   ",
    });

    // `deliverPortalInboxMessage` requires a subject, so this never reaches the
    // append branch — the guard is upstream, and the label is simply untouched.
    expect(blank.ok).toBe(false);
    const sent = tables.portal_inbox_thread_records!.find(
      (r) => (r.row_data as PersistedInboxThread).folder === "sent",
    )!;
    expect((sent.row_data as PersistedInboxThread).subject).toBe("Move-in packet");
  });

  it("keeps separate threads for different people", async () => {
    const { db, tables } = makeFakeDb();

    await deliverPortalInboxMessage(db, baseOpts("hi founders", "s"));
    await deliverPortalInboxMessage(db, {
      ...baseOpts("hi other", "s"),
      toEmails: ["someone-else@example.com"],
    });

    const sent = tables.portal_inbox_thread_records!.filter(
      (r) => (r.row_data as PersistedInboxThread).folder === "sent",
    );
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((r) => (r.row_data as PersistedInboxThread).email))).toEqual(
      new Set([RECIPIENT, "someone-else@example.com"]),
    );
  });
});
