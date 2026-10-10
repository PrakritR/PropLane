import { describe, expect, it } from "vitest";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";
import { deliverPortalMessageThreadSide, stablePersonThreadId } from "@/lib/portal-inbox-delivery";

/**
 * Root cause of "one new thread per payment": a batch of charges for ONE resident
 * emits several payment events in the same second. Each delivery looked for the
 * resident's thread, found none (nobody had committed yet) and created its own
 * row under a fresh random id. The creation is now insert-only on an id that
 * depends on who the thread is between, so the loser of the race re-reads and
 * appends to the winner's thread.
 */
const MANAGER = "mgr-1";
const SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT = "resident@example.com";

function send(db: ReturnType<typeof createConversationFakeDb>, n: number, id = stablePersonThreadId(`msg_${MANAGER}`, SCOPE, MANAGER, RESIDENT, "house-1")) {
  return deliverPortalMessageThreadSide(db, {
    scope: SCOPE,
    folder: "sent",
    ownerUserId: MANAGER,
    participantEmail: null,
    otherPartyEmail: RESIDENT,
    conversation: { propertyId: "house-1", managerUserId: MANAGER },
    fallbackId: id,
    serializeCreate: true,
    fromName: "Manager",
    subject: `Charge ${n} · Payment update`,
    body: `Charge ${n} was created.`,
    preview: `Charge ${n} was created.`,
    when: "Oct 9, 9:00 AM",
    unread: false,
    outbound: true,
    messageId: `action-event:charge-${n}`,
  });
}

const threads = (db: ReturnType<typeof createConversationFakeDb>) =>
  db.tables.portal_inbox_thread_records!.filter((row) => row.scope === SCOPE);

describe("a burst of payment updates for one resident is one thread", () => {
  it("legacy path (no workspace to key on): concurrent creates collapse", async () => {
    const db = createConversationFakeDb({});
    await Promise.all([1, 2, 3, 4, 5].map((n) => send(db, n)));
    const rows = threads(db);
    expect(rows).toHaveLength(1);
    const data = rows[0]!.row_data as { messages?: unknown[] };
    // The root turn lives in `body`; the other four are appended.
    expect(data.messages).toHaveLength(4);
  });

  it("keyed path (workspace + conversation key): concurrent creates collapse", async () => {
    const db = createConversationFakeDb({
      portal_workspaces: [{ id: "ws-1", owner_user_id: MANAGER, is_default: true }],
    });
    await Promise.all([1, 2, 3, 4, 5].map((n) => send(db, n)));
    const rows = threads(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_key).toBe(`mail:${RESIDENT}`);
    expect((rows[0]!.row_data as { messages?: unknown[] }).messages).toHaveLength(4);
  });

  it("later sends keep appending to the same thread", async () => {
    const db = createConversationFakeDb({
      portal_workspaces: [{ id: "ws-1", owner_user_id: MANAGER, is_default: true }],
    });
    await send(db, 1);
    await send(db, 2);
    await send(db, 3);
    expect(threads(db)).toHaveLength(1);
  });

  it("an id already used by another person's thread never drops the message", async () => {
    const taken = stablePersonThreadId(`msg_${MANAGER}`, SCOPE, MANAGER, RESIDENT, "house-1");
    const db = createConversationFakeDb({
      portal_inbox_thread_records: [
        {
          id: taken,
          scope: SCOPE,
          owner_user_id: MANAGER,
          participant_email: null,
          thread_type: "portal_message",
          row_data: { id: taken, folder: "sent", email: "someone-else@example.com", messages: [] },
          updated_at: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    const result = await send(db, 1);
    expect(result.action).toBe("create");
    expect(result.threadId).not.toBe(taken);
    expect(threads(db)).toHaveLength(2);
  });

  it("different residents and different houses get different stable ids", () => {
    const a = stablePersonThreadId("msg_m", SCOPE, "m", "a@x.co", "h1");
    expect(stablePersonThreadId("msg_m", SCOPE, "m", "A@x.co", "h1")).toBe(a);
    expect(stablePersonThreadId("msg_m", SCOPE, "m", "b@x.co", "h1")).not.toBe(a);
    expect(stablePersonThreadId("msg_m", SCOPE, "m", "a@x.co", "h2")).not.toBe(a);
  });
});
